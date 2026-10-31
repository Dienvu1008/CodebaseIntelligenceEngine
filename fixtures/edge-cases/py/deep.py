import importlib


class Outer:
    class Inner:
        def method(self):
            def local():
                return importlib.import_module(self.name)
            return local


async def coroutine():
    return None
