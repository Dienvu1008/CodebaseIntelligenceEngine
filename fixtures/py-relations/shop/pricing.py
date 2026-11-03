RATE = 0.2


def tax(amount):
    return amount * RATE


def discount(amount, rate=RATE):
    return amount * (1 - rate)


def scaled(tax=tax):
    return tax(1)


def total(items):
    tax = 0  # a local that shadows the function: not a reference to it
    for price in items:
        tax += price
    return tax


def counter():
    global RATE
    RATE = RATE + 1
    return RATE


def outer():
    def inner():
        return tax(1)

    return inner()


def squares(values):
    return [discount(v) for v in values if (n := v) > 0]


def decorate(fn):
    return fn


@decorate
def decorated():
    return (lambda tax: tax)(2)
