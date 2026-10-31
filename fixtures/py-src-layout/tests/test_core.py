import pytest
from pkg.core import run


def test_run():
    assert run([1]) is not None
