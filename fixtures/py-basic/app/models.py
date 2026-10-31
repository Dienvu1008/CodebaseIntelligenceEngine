import os
from dataclasses import dataclass


@dataclass
class User:
    """A user."""

    name: str

    def home(self):
        return os.path.join("/home", self.name)


def make_user(name):
    return User(name)
