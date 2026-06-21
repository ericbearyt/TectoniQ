"""
clinical_linker.py — Vocabulary-Linking Engine (warm singleton)
================================================================
The heart of the medical-term allowlist. Replaces stopword/blocklist filtering
with vocabulary linking: a span survives only if scispaCy can link it to a
clinical concept in the UMLS knowledge base above a similarity floor. Common
words ("patient", "reports", "yesterday") don't link, so they fall away.

Design (per the agreed plan):
  - scispaCy `en_core_sci_*` NER finds entity-like spans.
  - scispaCy `scispacy_linker` (UMLS KB) links spans → CUI + canonical name +
    semantic types (TUIs) + similarity score.
  - medspaCy ConText flags negated mentions ("denies chest pain").
  - The model + ~1GB KB are loaded ONCE (warm singleton) and reused across all
    documents. Streaming via `nlp.pipe` gives batched throughput; we deliberately
    do NOT fork worker processes — the cost here is the 1GB KB, and forking would
    pay that per process. Load once, stream many.

Graceful degradation: if the stack can't load (model missing, KB download
failed, wrong Python), `is_available()` returns False and callers fall back to
the legacy dictionary filter — mirroring how Worker 3 degrades without Gemini.

This module groups linked spans BY CUI (the concept-keyed timeline unit). It
returns raw concept aggregates; Worker 7 orders them, extracts dates, applies
the Gemini-adjudication cap, and finalises the timeline contract.
"""

from __future__ import annotations

import os
import threading
import warnings

# ── Tunables (env-overridable) ────────────────────────────────────────────
SCI_MODEL = os.getenv("SCI_MODEL", "en_core_sci_sm")
LINKER_KB = os.getenv("LINKER_KB", "umls")          # umls | mesh | rxnorm | go | hpo
LINK_FLOOR = float(os.getenv("LINK_FLOOR", "0.70"))   # below this: drop the span
LINK_ACCEPT = float(os.getenv("LINK_ACCEPT", "0.85"))  # at/above: auto-confident
# Keep-threshold: even if a span links above the candidate floor, drop the
# concept entirely if its best score is below this. Trims low-confidence
# mislinks (e.g. "APT compounds"@0.76) without loosening negation context.
LINK_KEEP_SCORE = float(os.getenv("LINK_KEEP_SCORE", "0.85"))
# #2: fewer nearest neighbours per mention = less per-mention scoring work.
LINK_K = int(os.getenv("LINK_K", "5"))
# #1: link unique mention strings in batches (one candidate-generator call per
# batch) and report progress per batch.
MENTION_BATCH = int(os.getenv("LINK_MENTION_BATCH", "1000"))

# Meta/qualifier concepts that link cleanly to real UMLS entries but carry no
# clinical timeline value. They're frequent, so a frequency floor can't catch
# them — deny by canonical name (lowercased, exact). This is the "denylist the
# junk that still links" complement to the vocabulary allowlist.
CONCEPT_DENYLIST = {
    "negative", "positive", "abnormal", "normal", "documented", "discontinued",
    "diagnosis", "diagnosis study", "test method", "analysis of substances",
    "biological assay", "pharmaceutical preparations", "laboratory procedures",
    "laboratory test finding", "laboratory test", "screening procedure",
    "evaluation procedure", "therapeutic procedure", "medical history",
    "patient visit", "physical examination", "report", "documentation",
    "measurement", "result", "finding", "findings", "value", "values",
    "unspecified", "other", "none", "present", "absent", "stable", "change",
}

_nlp = None
_linker = None
_has_context = False
_load_error: Exception | None = None
_load_lock = threading.Lock()

# Leading tokens that are negation/assertion cues, not part of the concept.
# scispaCy NER tends to absorb these into the entity span (e.g. "no chest pain"),
# which (a) hurts linking and (b) hides the cue from ConText. We trim them off
# the front of each entity so the cue survives as a standalone token that
# medspaCy ConText can match as a modifier.
_LEADING_CUES = {
    "no", "not", "denies", "denied", "deny", "without", "negative",
    "neg", "absent", "r/o", "ro", "non", "never", "none",
}


def _register_trim_component():
    """Register the entity-cue-trimming pipe factory (idempotent)."""
    from spacy.language import Language
    from spacy.tokens import Span

    if "trim_entity_cues" in Language.factories:
        return

    @Language.component("trim_entity_cues")
    def trim_entity_cues(doc):  # noqa: ANN001
        new_ents = []
        for ent in doc.ents:
            start = ent.start
            # Walk past leading cue tokens, but never consume the whole span.
            while start < ent.end - 1 and doc[start].lower_ in _LEADING_CUES:
                start += 1
            if start == ent.start:
                new_ents.append(ent)
            else:
                new_ents.append(Span(doc, start, ent.end, label=ent.label))
        doc.ents = new_ents
        return doc


def _load() -> None:
    """Load the model + KB exactly once. Safe to call repeatedly."""
    global _nlp, _linker, _has_context, _load_error
    if _nlp is not None or _load_error is not None:
        return
    with _load_lock:
        if _nlp is not None or _load_error is not None:
            return
        try:
            warnings.filterwarnings("ignore")
            import spacy
            import medspacy  # noqa: F401  (registers medspacy_context factory)
            from scispacy.abbreviation import AbbreviationDetector  # noqa: F401
            from scispacy.linking import EntityLinker  # noqa: F401

            # NER + linking don't need the tagger/parser/lemmatizer/attribute_ruler.
            # Dropping them is a large per-page speedup on big documents. ConText
            # needs sentence boundaries, so we add a cheap rule-based sentencizer
            # in place of the (disabled) parser.
            nlp = spacy.load(
                SCI_MODEL,
                disable=["tagger", "attribute_ruler", "lemmatizer", "parser"],
            )
            nlp.add_pipe("sentencizer", first=True)
            # Trim negation/assertion cues off entity spans right after NER, so
            # the cue survives as a standalone token (for ConText) and the span
            # links on the concept alone.
            _register_trim_component()
            nlp.add_pipe("trim_entity_cues", after="ner")
            nlp.add_pipe("abbreviation_detector")
            nlp.add_pipe(
                "scispacy_linker",
                config={
                    "resolve_abbreviations": True,
                    "linker_name": LINKER_KB,
                    # candidate-generation floor; final accept/adjudicate logic
                    # lives in tui_categories + worker7
                    "threshold": LINK_FLOOR,
                    "k": LINK_K,
                    "max_entities_per_mention": 1,
                },
            )
            try:
                nlp.add_pipe("medspacy_context")
                _has_context = True
            except Exception as ctx_err:  # negation is optional, never fatal
                print(f"[linker] ConText unavailable, negation disabled: {ctx_err}")
                _has_context = False

            _nlp = nlp
            _linker = nlp.get_pipe("scispacy_linker")
            print(
                f"[linker] ready — model={SCI_MODEL} kb={LINKER_KB} "
                f"floor={LINK_FLOOR} accept={LINK_ACCEPT} context={_has_context}"
            )
        except Exception as e:  # noqa: BLE001 — degrade, don't crash the pipeline
            _load_error = e
            print(f"[linker] FAILED to load ({type(e).__name__}: {e}) — falling back to legacy filter.")


def is_available() -> bool:
    """True if the linker stack loaded. Triggers a one-time warm load."""
    _load()
    return _nlp is not None


def warm_up() -> bool:
    """Eagerly load at server startup so the first upload isn't slow."""
    return is_available()


def _ent_flag(ent, name: str) -> bool:
    try:
        return bool(getattr(ent._, name))
    except (AttributeError, ValueError):
        return False


def analyze_sections(sections: list[dict], progress=None) -> list[dict] | None:
    """
    Run NER + linking + negation over each section, group spans by CUI.

    Parameters
    ----------
    sections : list of {id, header, page, content, section_group?}

    Returns
    -------
    list[concept] | None
        None if the linker is unavailable (caller falls back).
        Each concept:
        {
          "cui", "canonical_name", "category", "confident",
          "semantic_types": [TUI, ...], "aliases": [surface, ...],
          "best_score": float,
          "asserted_total": int, "negated_total": int,
          "occurrences": [
             {section_id, section_header, page, section_group,
              asserted, negated, surfaces:[...]}
          ]
        }
    """
    if not is_available():
        return None

    from .tui_categories import classify as classify_tuis

    # ── #3: deduplicate sections by content ──────────────────────────────────
    # A long record repeats boilerplate (visit templates, headers, admin pages).
    # Link each UNIQUE content once, then fan the results out to every section
    # that shares it — preserves per-page occurrences while doing the work once.
    groups: dict[str, dict] = {}     # content -> {"metas": [...]}
    order: list[str] = []
    for s in sections:
        content = s.get("content", "") or ""
        if not content.strip():
            continue
        g = groups.get(content)
        if g is None:
            g = {"metas": []}
            groups[content] = g
            order.append(content)
        g["metas"].append({
            "id": s["id"],
            "header": s.get("header", ""),
            "page": s.get("page", 0),
            "group": s.get("section_group", "other"),
        })

    # ── NER + negation pass over UNIQUE contents (linker disabled here) ──────
    # We run the heavy entity linker manually below on UNIQUE mention strings,
    # so skip the in-pipe linker — that's the whole speedup.
    resolve_abbr = getattr(_linker, "resolve_abbreviations", True)
    ent_records: list[tuple] = []    # (content_key, mention_string, surface, negated)
    mention_set: set[str] = set()

    for doc, key in _nlp.pipe([(c, c) for c in order], as_tuples=True,
                              disable=["scispacy_linker"]):
        for ent in doc.ents:
            surface = " ".join(ent.text.split())
            if not surface:
                continue
            # Mirror EntityLinker: link the abbreviation's long form when known.
            mstr = ent.text
            if resolve_abbr:
                lf = getattr(ent._, "long_form", None)
                if lf is not None:
                    mstr = lf.text if hasattr(lf, "text") else str(lf)
            mstr = " ".join(mstr.split())
            negated = _ent_flag(ent, "is_negated") if _has_context else False
            ent_records.append((key, mstr, surface, negated))
            mention_set.add(mstr)

    # ── #1: link each UNIQUE mention string ONCE, in batches ─────────────────
    # Replicates EntityLinker.__call__ scoring exactly (threshold,
    # no_definition_threshold, filter_for_definitions) so results don't change —
    # we just stop re-linking the same string thousands of times.
    kb = _linker.kb
    no_def = getattr(_linker, "no_definition_threshold", 0.95)
    filter_defs = getattr(_linker, "filter_for_definitions", True)
    unique = [m for m in mention_set if m]
    link_map: dict[str, tuple | None] = {}

    nbatches = max(1, (len(unique) + MENTION_BATCH - 1) // MENTION_BATCH)
    for bi in range(nbatches):
        chunk = unique[bi * MENTION_BATCH:(bi + 1) * MENTION_BATCH]
        if not chunk:
            continue
        for mstr, cands in zip(chunk, _linker.candidate_generator(chunk, LINK_K)):
            best = []
            for cand in cands:
                score = max(cand.similarities)
                if (filter_defs
                        and kb.cui_to_entity[cand.concept_id].definition is None
                        and score < no_def):
                    continue
                if score > LINK_FLOOR:
                    best.append((cand.concept_id, score))
            best.sort(key=lambda x: x[1], reverse=True)
            link_map[mstr] = best[0] if best else None
        if progress is not None:
            try:
                progress(bi + 1, nbatches)
            except Exception:
                pass

    # ── Group by CUI, fanning occurrences out to all duplicate sections ──────
    concepts: dict[str, dict] = {}
    for key, mstr, surface, negated in ent_records:
        linked = link_map.get(mstr)
        if not linked:
            continue
        cui, score = linked
        kb_entity = kb.cui_to_entity[cui]
        # Denylist meta/qualifier concepts that link but mean nothing here.
        if kb_entity.canonical_name.lower() in CONCEPT_DENYLIST:
            continue
        tuis = list(kb_entity.types)
        for meta in groups[key]["metas"]:
            agg = concepts.get(cui)
            if agg is None:
                category, confident = classify_tuis(tuis, meta["group"])
                agg = {
                    "cui": cui,
                    "canonical_name": kb_entity.canonical_name,
                    "category": category,
                    "confident": confident,
                    "semantic_types": tuis,
                    "aliases": set(),
                    "best_score": 0.0,
                    "asserted_total": 0,
                    "negated_total": 0,
                    "_occ": {},  # section_id -> occurrence aggregate
                }
                concepts[cui] = agg

            agg["aliases"].add(surface.lower())
            agg["best_score"] = max(agg["best_score"], float(score))
            if negated:
                agg["negated_total"] += 1
            else:
                agg["asserted_total"] += 1

            sid = meta["id"]
            occ = agg["_occ"].get(sid)
            if occ is None:
                occ = {
                    "section_id": sid,
                    "section_header": meta["header"],
                    "page": meta["page"],
                    "section_group": meta["group"],
                    "asserted": 0,
                    "negated": 0,
                    "surfaces": set(),
                }
                agg["_occ"][sid] = occ
            occ["surfaces"].add(surface)
            if negated:
                occ["negated"] += 1
            else:
                occ["asserted"] += 1

    # Finalise: convert sets/maps to lists.
    out = []
    for agg in concepts.values():
        occurrences = []
        for occ in agg["_occ"].values():
            occurrences.append(
                {
                    "section_id": occ["section_id"],
                    "section_header": occ["section_header"],
                    "page": occ["page"],
                    "section_group": occ["section_group"],
                    "asserted": occ["asserted"],
                    "negated": occ["negated"],
                    "surfaces": sorted(occ["surfaces"]),
                }
            )
        out.append(
            {
                "cui": agg["cui"],
                "canonical_name": agg["canonical_name"],
                "category": agg["category"],
                "confident": agg["confident"],
                "semantic_types": agg["semantic_types"],
                "aliases": sorted(agg["aliases"]),
                "best_score": round(agg["best_score"], 4),
                "asserted_total": agg["asserted_total"],
                "negated_total": agg["negated_total"],
                "occurrences": occurrences,
            }
        )
    return out
