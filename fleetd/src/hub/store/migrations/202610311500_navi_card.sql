-- The card a Navi pays with (D265 navi.purchases): a Credit Card item in its person's 1Password, kept as its
-- op://vault/item reference only. NULL: the Navi has no card, and refuses to buy.
ALTER TABLE assistants ADD COLUMN card_ref TEXT;
