## 19.03.2026 - Nedostupnost filtrování a další issues

**Složitost filtrování pro uživatele** — Atributy jsou rozházené mezi mnoho souvisejících entit, což uživatelům znemožňuje sestavit si filtry, jaké potřebují. Jde o opakující se feedback z uživatelského testování.

**Stav „uvedení do komerce" nelze filtrovat** — Stavové pole pro uvedení do komerce aktuálně nepodporuje filtrování. Příčinou je způsob implementace (není to plugin), a dokud se to nevyřeší, nedá se s tím pole prakticky pracovat.

**Závislost mezi problémy** — Existuje otázka, zda řešení obecného filtru nemá počkat na návrh řešení pro stav uvedení do komerce, aby se změny vzájemně neovlivnily. Může jít ale o zbytečnou opatrnost.

**Reklamace a modularizace** — U reklamačních formulářů se navrhuje rozdělit je do menších modulů místo jednoho monolitického formuláře. Z pohledu UI to není blokér — data lze posílat z normalizovaného datového modelu a formuláře mohou vypadat tak, jak je potřeba.

**Celková velikost úkolu** — Jde o velký a komplexní problém, který se nevyřeší snadno. Plánují se další schůzky k decomissioningu a budoucímu návrhu.