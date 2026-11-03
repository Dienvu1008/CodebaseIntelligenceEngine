from shop.pricing import tax, total as sum_up
from shop import pricing


class Cart:
    limit = 10

    def __init__(self, items):
        self.items = items

    def checkout(self):
        pricing.discount(1)
        self.check()
        return tax(total_of(self.items))

    def check(self):
        return len(self.items) < Cart.limit


def total_of(items):
    return sum_up(items)


def main():
    cart = Cart([1, 2])
    return cart.checkout()


main()
