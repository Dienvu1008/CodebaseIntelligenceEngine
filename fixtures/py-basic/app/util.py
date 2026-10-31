import json
import requests
from app.models import make_user, Missing
import app.sub.deep


def dump(user):
    return json.dumps({"name": user.name})
