# Reklamace v procesu ROP do komerce

> **Typ dokumentu:** Konsolidovaná BA analýza **Stav:** Draft — k validaci se stakeholdery **Datum:** 2026-03-24 **Autor:** Ondřej (BA Lead, Analytics Chapter)

---

## 1 Shrnutí

Reklamace v procesu ROP do komerce nemají v současnosti vlastní životní cyklus, strukturovaná data ani reporting. Jsou vedeny jako prosté úkoly v Portálu výstavby. Tento dokument konsoliduje poznatky z dosavadní analýzy a posledního meetingu, definuje současný stav, navrhovaný cílový stav a identifikuje otevřené body ke konsolidaci.

---

## 2 Současný stav (AS-IS)

### 2.1 Vznik reklamace

Reklamace může vzniknout v kterémkoli bodě procesu ROP do komerce, kdykoli některá z front zjistí chybu — ať už v dokumentaci, fyzickém provedení nebo datové správnosti.

### 2.2 Směrování reklamace

Defaultní nastavení vrací reklamaci na začátek procesu (k PC). V praxi si však zakládající uživatel může vybrat, kam reklamaci vrátí — nemusí se vracet na začátek, pokud je zřejmé, koho se chyba týká. Tím se zkracuje průběžná doba řešení.

**Příklady směrování:**

- Výstupní kontrola zjistí, že KPS 1 špatně vystavila pracovní příkaz → vrací přímo na KPS 1 (ne na PC).
- Příprava služeb zjistí pozdě, že KPS 4 něco přehlédla → vrací nejhůř na KPS 4.
- Kopeluk si všimne nesrovnalosti → může vrátit komukoli, někdy i nesystémově (telefonátem).

### 2.3 Identifikované problémy



---

## 3 Cílový stav (TO-BE) — návrh

### 3.1 Reklamace jako samostatná entita

Reklamace přestane být úkolem a stane se samostatným typem s vlastním životním cyklem:

**Zadaná → Řešená → Ukončená**

### 3.2 Klíčové schopnosti cílového řešení

- **Pozastavení procesu ROP do komerce** — reklamace vstupuje do procesu a může ho blokovat.
- **Měření času** — automatické počítání doby strávené v jednotlivých stavech (hodiny, dny). Odpadá ruční skládání reportů.
- **Flexibilní směrování** — možnost směřovat reklamaci nejen na PC, ale i do dřívějších fází procesu (projekce, plánování).
- **Standardizace pravidel** — omezený počet variant směrování („2 varianty místo 70"), aby systém zůstal udržitelný.

---

## 4 Open points ke konsolidaci

|#|Otevřený bod|Kontext / rozpor|Vlastník / další krok|
|---|---|---|---|
|OP1|**Míra volnosti směrování** — Uživatelé chtějí absolutní volnost (zadat reklamaci komukoli). Cílový stav naopak navrhuje standardizaci s omezeným počtem variant.|Rozpor mezi flexibilitou (AS-IS praxe) a udržitelností (TO-BE návrh).|Ověřit s Pavlem, zda je přijatelné omezit volnost uživatelů, a definovat akceptovatelnou míru standardizace.|
|OP2|**Průnik s reklamacemi správy sítě** — Existují reklamace služeb ve správě sítě, které mohou mít průniky s reklamacemi v procesu ROP do komerce.|Není jasné, zda jde o stejný doménový objekt, nebo dva odlišné procesy se společným názvem.|Sednout si s lidmi ze správy sítě a zmapovat průniky.|
|OP3|**Doménový model reklamace** — Reklamace zatím nemá formální entitní model s vazbou na ROPky a proces ROP do komerce.|Bez modelu nelze navrhnout datovou strukturu ani API.|Navrhnout doménový model reklamace jako samostatné entity (DDD aggregate) s vazbami na existující bounded contexts.|
|OP4|**Odpovědnost PC při akceptaci** — PC aktuálně jen odklikne, chybí mechanismus vynucování kvality.|Není definováno, co se stane, když PC odmítne akceptaci, ani jaká kritéria musí být splněna.|Definovat akceptační kritéria a eskalační scénář při nesplnění.|
|OP5|**Nesystémová komunikace** — Část reklamací se řeší mimo portál (telefonáty, e-maily).|Pokud reklamace neprochází systémem, nelze ji měřit ani reportovat.|Rozhodnout, zda nesystémové reklamace tolerovat, nebo vynucovat zadání přes portál.|

---

## 5 Navrhované další kroky

1. **Workshop se správou sítě** — zmapovat průniky reklamací služeb a reklamací ROP do komerce (→ OP2).
2. **Validace se stakeholderem (Pavel)** — rozhodnout míru standardizace vs. flexibility směrování (→ OP1).
3. **Doménový model** — navrhnout reklamaci jako samostatný aggregate root s vazbami na ROPku, frontu, fázi procesu (→ OP3).
4. **Definice akceptačních kritérií** — co musí PC splnit při akceptaci, eskalační scénáře (→ OP4).
5. **Rozhodnutí o nesystémových reklamacích** — tolerovat, nebo vynucovat systémové zadání (→ OP5).