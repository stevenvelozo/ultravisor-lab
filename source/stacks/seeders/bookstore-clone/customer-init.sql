-- Bookstore-Clone stack — customer database seed (MySQL).
--
-- Mounted read-only into customer-mysql at
-- /docker-entrypoint-initdb.d/01-bookstore.sql; MySQL runs it on first
-- init (empty data dir). Models a *customer's existing* operational DB:
-- deliberately awkward keys so the clone-to-lake has to cope without
-- unique identifiers.
--
--   * String keys instead of integer IDs (City, Author, Bookstore, Cashier).
--   * Combinatorial keys with no single unique column (Book = Title+AuthorName).
--   * No unique identifier at all + intentional duplicates
--     (Price, Sale — Sale's "key" is the three strings BookstoreCode+Title+SaleDate,
--      and several rows collide on all three; a couple are byte-for-byte dupes
--      so the lake's RecordMD5 can flag exact copies).
--
-- None of these tables declare a PRIMARY KEY or AUTO_INCREMENT surrogate —
-- that is the whole point. The retold-databeacon introspects + serves them
-- read-only; the clone PullRecords reads raw rows and the lake archives them
-- keyed positionally (record-N), needing no source identifier.

CREATE DATABASE IF NOT EXISTS customer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE customer;

-- ── City ── string key CityName; CityName alone is NOT unique (two Portlands,
--            two Salems, two Athens) — uniqueness needs CityName + StateCode.
CREATE TABLE City
(
	CityName    VARCHAR(120) NOT NULL,
	StateCode   VARCHAR(2)   NOT NULL,
	Population   INT          NULL,
	Country     VARCHAR(64)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO City (CityName, StateCode, Population, Country) VALUES
	('Portland',    'OR', 652503, 'USA'),
	('Portland',    'ME',  68408, 'USA'),
	('Salem',       'OR', 177723, 'USA'),
	('Salem',       'MA',  44480, 'USA'),
	('Athens',      'GA', 127315, 'USA'),
	('Athens',      'OH',  23849, 'USA'),
	('Austin',      'TX', 961855, 'USA');

-- ── Author ── string key AuthorName; no integer id.
CREATE TABLE Author
(
	AuthorName  VARCHAR(160) NOT NULL,
	BirthYear   INT          NULL,
	Country     VARCHAR(64)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO Author (AuthorName, BirthYear, Country) VALUES
	('Ursula K. Le Guin', 1929, 'USA'),
	('Octavia E. Butler', 1947, 'USA'),
	('Jorge Luis Borges', 1899, 'Argentina'),
	('Italo Calvino',     1923, 'Italy'),
	('Toni Morrison',     1931, 'USA');

-- ── Bookstore ── string key BookstoreCode; references City by (CityName,StateCode).
CREATE TABLE Bookstore
(
	BookstoreCode  VARCHAR(16)  NOT NULL,
	BookstoreName  VARCHAR(160) NOT NULL,
	CityName       VARCHAR(120) NOT NULL,
	StateCode      VARCHAR(2)   NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO Bookstore (BookstoreCode, BookstoreName, CityName, StateCode) VALUES
	('PDX-01', 'Powell''s on Burnside', 'Portland', 'OR'),
	('PDX-02', 'Annie Bloom''s Books',  'Portland', 'OR'),
	('SAL-01', 'Salem Reads',           'Salem',    'OR'),
	('ATX-01', 'BookPeople',            'Austin',   'TX'),
	('ATH-01', 'Athens Books',          'Athens',   'GA');

-- ── Book ── COMBINATORIAL key (Title, AuthorName); no id. "Echoes" appears
--            under two different authors, so Title alone collides.
CREATE TABLE Book
(
	Title       VARCHAR(200) NOT NULL,
	AuthorName  VARCHAR(160) NOT NULL,
	Genre       VARCHAR(64)  NULL,
	PubYear     INT          NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO Book (Title, AuthorName, Genre, PubYear) VALUES
	('The Dispossessed',          'Ursula K. Le Guin', 'SciFi',   1974),
	('The Left Hand of Darkness', 'Ursula K. Le Guin', 'SciFi',   1969),
	('Kindred',                   'Octavia E. Butler', 'SciFi',   1979),
	('Labyrinths',                'Jorge Luis Borges', 'Fiction', 1962),
	('Invisible Cities',          'Italo Calvino',     'Fiction', 1972),
	('Beloved',                   'Toni Morrison',     'Fiction', 1987),
	('Echoes',                    'Ursula K. Le Guin', 'SciFi',   1980),
	('Echoes',                    'Toni Morrison',     'Fiction', 1990);

-- ── Cashier ── string key CashierCode; references Bookstore by code.
CREATE TABLE Cashier
(
	CashierCode    VARCHAR(24)  NOT NULL,
	FullName       VARCHAR(160) NOT NULL,
	BookstoreCode  VARCHAR(16)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO Cashier (CashierCode, FullName, BookstoreCode) VALUES
	('PDX-01-A', 'Maya Chen',     'PDX-01'),
	('PDX-01-B', 'Liam O''Brien', 'PDX-01'),
	('SAL-01-A', 'Priya Patel',   'SAL-01'),
	('ATX-01-A', 'Diego Ramirez', 'ATX-01'),
	('ATH-01-A', 'Sarah Johnson', 'ATH-01');

-- ── Price ── NO unique id. Natural key (Title, BookstoreCode, EffectiveDate)
--             — and even that is not enforced: two rows share
--             ('The Dispossessed','PDX-01','2024-06-01') with different prices.
--             EffectiveDate is a STRING column (YYYY-MM-DD).
CREATE TABLE Price
(
	Title          VARCHAR(200)  NOT NULL,
	BookstoreCode  VARCHAR(16)   NOT NULL,
	EffectiveDate  VARCHAR(10)   NOT NULL,
	Price          DECIMAL(10,2) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO Price (Title, BookstoreCode, EffectiveDate, Price) VALUES
	('The Dispossessed', 'PDX-01', '2024-01-01', 16.99),
	('The Dispossessed', 'PDX-01', '2024-06-01', 17.99),
	('The Dispossessed', 'PDX-01', '2024-06-01', 18.50),  -- collides on all 3 key columns
	('Kindred',          'PDX-01', '2024-01-01', 15.00),
	('Kindred',          'SAL-01', '2024-01-01', 15.50),
	('Invisible Cities', 'ATX-01', '2024-03-01', 14.00);

-- ── Sale ── the headline case: uniqueness needs the THREE string columns
--            BookstoreCode + Title + SaleDate, and the data deliberately
--            collides on them. Rows 1/2 share the 3-col key (different cashier
--            + qty); rows 1/3 are byte-for-byte identical (RecordMD5 will match);
--            rows 5/6 are identical; rows 7/8 share the 3-col key.
CREATE TABLE Sale
(
	BookstoreCode  VARCHAR(16)   NOT NULL,
	Title          VARCHAR(200)  NOT NULL,
	SaleDate       VARCHAR(10)   NOT NULL,
	CashierCode    VARCHAR(24)   NULL,
	Quantity       INT           NULL,
	UnitPrice      DECIMAL(10,2) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO Sale (BookstoreCode, Title, SaleDate, CashierCode, Quantity, UnitPrice) VALUES
	('PDX-01', 'The Dispossessed', '2024-07-04', 'PDX-01-A', 1, 17.99),
	('PDX-01', 'The Dispossessed', '2024-07-04', 'PDX-01-B', 2, 17.99),  -- 3-col-key dup of row 1
	('PDX-01', 'The Dispossessed', '2024-07-04', 'PDX-01-A', 1, 17.99),  -- exact dup of row 1
	('PDX-01', 'Kindred',          '2024-07-04', 'PDX-01-A', 1, 15.00),
	('SAL-01', 'Kindred',          '2024-07-05', 'SAL-01-A', 3, 15.50),
	('SAL-01', 'Kindred',          '2024-07-05', 'SAL-01-A', 3, 15.50),  -- exact dup of row 5
	('ATX-01', 'Invisible Cities', '2024-07-06', 'ATX-01-A', 1, 14.00),
	('ATX-01', 'Invisible Cities', '2024-07-06', 'ATX-01-A', 2, 14.00),  -- 3-col-key dup of row 7
	('ATH-01', 'Beloved',          '2024-07-07', 'ATH-01-A', 1, 18.00);
