"""Entry point: absolute, submodule, dynamic and third-party imports."""
import importlib
import app
from app import models, util
import yaml

plugin = importlib.import_module(name)
helper = importlib.import_module("app.util")


def main():
    return models.make_user("x")
