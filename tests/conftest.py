"""
Pytest configuration: add repo root to sys.path so 'backend' package is importable.
"""
import sys
import os

# Ensure the repo root (parent of this tests/ dir) is on the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
