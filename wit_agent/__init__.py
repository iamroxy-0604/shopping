"""Wit shopping sidecar."""

__all__ = ("ShoppingAgent",)


def __getattr__(name):
    if name == "ShoppingAgent":
        from .agent import ShoppingAgent

        return ShoppingAgent
    raise AttributeError(name)
