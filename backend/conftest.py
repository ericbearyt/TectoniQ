"""Make the backend/ directory importable so tests can `from workers import ...`."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
