-- Runs once when the Postgres volume is first created: a separate database
-- for the test suite, so tests never touch the demo data.
CREATE DATABASE hela_test OWNER hela;
