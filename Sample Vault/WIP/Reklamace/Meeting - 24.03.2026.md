# Shrnutí schůzky — Proces reklamací v Portálu výstavby

## Kdo může zakládat reklamaci

Reklamaci mohou zakládat uživatelé ze **4 front**:

- KPS 4
- KPS 1
- Výstupní kontrola
- Čeká na odkapování (fronta pana Kopeluka)

## Práce ve frontě

Uživatel ve své frontě vidí všechny řádky (ROPky), které mu „napadaly" + dosud neodbavené — průběžně přibývají a uživatelé je postupně odbavují. K dispozici je filtrování podle dílčí dodávky a řada dalších filtrů, které si uživatelé staví na míru.

Reklamaci lze založit pro **jednu ROPku, více ROPek, nebo celou dílčí dodávku**. Technicky je možné založit reklamaci i napříč více dílčími dodávkami (filtr je nezávislý), ale v praxi to **nedává smysl** — každá dílčí dodávka je definovaná vlastní dokumentací.

## Založení reklamace

Při zakládání reklamace existuje volba **„Vyžadováno ověření zadavatelem"** — aktuálně je volitelná (uživatel si vybírá ano/ne), ale zpětná vazba směřuje k tomu, aby byla povinná vždy. Tato volba pravděpodobně platí pro všechny typy úkolů, nejen reklamace (_nepotvrzená domněnka — je třeba ověřit_).

Po založení reklamace se tato odešle přiřazenému řešiteli.

## Životní cyklus reklamace (stavový model)

Reklamace využívá dvouúrovňový stavový model:

- **Stav** — hrubý stav: `Aktivní` / `Neaktivní`
- **Důvod stavu** — jemnější podstav, např. `Čeká na převzetí`, `Čeká na ověření`, `Uzavřeno`

Pojmenování „důvod stavu" je poněkud matoucí — ve skutečnosti jde o detailnější fázi v rámci stavu. Toto názvosloví vzniklo historicky při vývoji.

### Akce řešitele po obdržení reklamace

Řešitel (např. PC = projektový koordinátor) má **3 možnosti**:

1. **Odmítnout úkol** — reklamace se vrací zpět zadavateli. Řešitel může (ale nemusí) vyplnit důvod odmítnutí. Příklad: „Toto není moje dílčí dodávka."
2. **Předat jinému řešiteli** — bez vlastního převzetí pošle reklamaci dál konkrétnímu uživateli nebo celému týmu. Příklad: „To nemám řešit já, ale Karel."
3. **Převzít úkol** — řešitel přijme reklamaci na sebe a pracuje na ní (mimo systém, žádná integrace na další nástroje).

### Po vyřešení

Když řešitel považuje reklamaci za vyřešenou, má opět **2 možnosti**:

1. **Předat jinému řešiteli** — pokud ví, že po něm má ještě někdo kontrolovat (např. PC předá zpět na KPS 4).
2. **Vyřešit úkol** — tím „přestanou tikat hodiny" a reklamace přechází do stavu ověření.

### Ověření zadavatelem

Původní zadavatel reklamace si přečte výsledek, prohlédne dokumentaci a rozhodne:

- **Přijmout řešení** → reklamace přechází do stavu `Neaktivní` / `Uzavřeno`
- **Odmítnout řešení** → reklamace se vrací zpět řešiteli (cyklus se opakuje)

## Logování a historie

Celý průběh reklamace se zaznamenává do **časového logu** — každá akce (vytvoření, převzetí, předání, vyřešení, odmítnutí) se zapíše s časovou značkou. K jednotlivým záznamům lze přidat:

- Textové poznámky
- Malé přílohy (limit cca 5 MB)

Systém umí trackovat celou historii, ale **log není ideální podklad pro reporting** — data v něm jsou, ale nejsou strukturovaná pro snadné vyhodnocování.

## Vazba na ROPky a hierarchie

- Ze záložky „Reklamace" na formuláři ROPky je vidět seznam všech reklamací, které se dané ROPky týkaly (může jich být víc).
- Formulář ROPky ukazuje, zda je ROPka **aktuálně** v reklamaci, ale i historické reklamace jsou dohledatelné.
- Hierarchie entit: **ROPka → Etapa → Projekt**

## Proč je potřeba reklamace předělat

Současné řešení je funkčně v pořádku, ale je implementováno jako **standardizovaný úkol**, který neumožňuje přidat custom pole. Konkrétně chybí:

1. **Druh reklamace** (číselník)
2. **Důvod reklamace** (číselník)

Tyto dva atributy jsou požadovány pro kategorizaci a reporting. Mezitím je VCRM (na požadavek Pavla Michala) již implementoval po svém, ale v Portálu výstavby chybí.

### Historický kontext

Když se reklamace původně nabíraly, kategorizace nebyla součástí požadavků a nikdo nedělal reporting. Po nasazení uživatelé řekli, že funkčně je vše OK, ale potřebují kategorizaci navíc. Standardizovaný úkol ji ale neumožňuje přidat.

### Návrh do budoucna

Reklamace by měla být **vlastní entita** (ne podtyp úkolu), která:

- Má vlastní atributy (druh, důvod)
- Může mít vlastní úkoly
- Lépe eviduje, odkud přišla a kam šla (strukturovaně, ne jen přes log)

## Otevřené otázky k řešení

- **Číselníky druh/důvod** — dosud nikdo neudělal analýzu, zda by to nemohl být jeden číselník místo dvou.
- **Vazba číselníku na roli** — _domněnka:_ hodnoty v číselnících by mohly/měly být závislé na frontě zadavatele. Např. KPS 1 by neměla vidět důvody relevantní pro KPS 4 a naopak. Pan Kopeluk by mohl vracet za jakýkoli důvod. Výstupní kontrola má zase své specifické důvody. Toto je složitější na vývoj, ale z pohledu uživatele zjednodušuje výběr.
- **Ověření „Vyžadováno ověření zadavatelem"** — ověřit, zda platí pro všechny typy úkolů.

## Lidé a role zmínění v kontextu

|Kdo|Kontext|
|---|---|
|Tomáš Opruštil|Vytvářel zadání reklamačního procesu|
|Honza Pivný|Stavěl technické řešení reklamací|
|Pavel Michal|Požadoval kategorizaci v VCRM|

## Postřeh z praxe

PC (projektoví koordinátoři) poměrně často posílají věci do komerce bez důkladné kontroly — to vede k vysokému počtu reklamací. Reklamace jsou trackované, takže vysoká chybovost PC je viditelná a řeší se manažersky.