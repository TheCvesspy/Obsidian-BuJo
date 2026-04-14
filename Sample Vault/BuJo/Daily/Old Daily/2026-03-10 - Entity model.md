### Poznámky k entity model workshopu

- Entity
    - Zdrojové
        - Poptávka - předchůdce projektu
            - Zdrojový systém
            - ID v zdroji
            - Interné ID
        - Kontakt - fyzické osoby
            - jméno
            - Příjmení
            - Datum narození
        - Organizace
            - IČO
            - DIČ
            - Jméno
            - Primární kontakt
            - Typ (dodavatel, zákazník, interní)
            
    - Projektové
        - Projekt - stavba na max jedno stavebné povolenie
            - Okres  (iné admin oblasti? viac okresov?)
            - Jestli je dotační
            - SPP Prvek (nie je to skupina výdajov s iným vzťahom?)
            - Plánované zahájení
            - Planovaný konec
            - Typ projektu (asi rozbiť na viac faktorov)
                - Potřebuje stavební povolení
                - Počet kol schválení před výstavbou
                - Infrastruktura (optika, metalika, vzduch, plast)
            - Objednatel (Cetin / Externí / Stát)
        - Program? - funkčná skupina projektov
            - Typ synergie
        - Portfolio? - finančá skupina projektov
            - Typ investice
    - Řízení projektu
        - Členové týmu projektu
            - Projekt
            - Uživatel
            - Od
            - Do
            - Role
        - Úkol - konkrétní zadání pro člověka s časem
            - Název
            - ID
            - Popis
            - Projekt
            - Etapa
            - Přiřazení
            - Štítky
            - Plánované od
            - Plánované do
            - Skutečné od
            - Skutečné do
            - Body úkolu
            - Je klíčový úkol
            - Mílník
            - Vlastník - JEDEN, zodpovědná osoba, ručitel (accountable)
            - Vykonávajíci, provádějící osoby, klidné víc (responsible) - kontakty?
        - Baseline - snapshot úkolov na tasku, hlavička
            - Projekt
            - Datum
            - Popis
        - Úkol Baselinu - snashot konkrétního úkolu
            - Úkol
            - Baseline
            - Datum začátku
            - Datum konce
        - Etapa - fyzické rozdělení projektu na části (lokalita / páteř vs koncový kabel)
            - Projekt
            - Začátek etapy očekávaný (vpyočteno podle úkolu)
            - Konec etapy koncový
            - Začátek etapy reálný
            - Konec etapy reálný
        - Mílník
            - Projekt
            - Datum
            - Název
            - Popis
            - Typ (Externí, Interní, Soukromý)
        - Baseline Mílniku
            - Milník
            - Baseline
            - Datum
    - Finance
        - Investiční komise
            - Projekt
            - Datum rozhodnutí
            - Index kola
            - Stav
        - Členové investiční komise
            - Komise
            - Člen
            - Stav
        - Nákladová položka
            - Projekt
            - Plánovaná částka
            - Skutečná částka
            - Stav
    - Jiné
        - Firemní rozdělení
            - Uživatel
            - Územní celek
            - Role
            - Od
            - Do
        - Příloha / Soubor
            - Tabulka
            - Záznam
            - Účel (SD, DSPS,Stavební povolení,....)
        - Dotační Program?
            - ID
            - Od
            - Do
            - Termín pro žádosti

### Generované zápisky

# Portál výstavby – Informační model: Strukturované poznámky

**Workshop:** Entitní / informační model pro Portál výstavby (nová optika)  
**Zpracoval:** Cvešpr Ondřej  
**Zdroj:** Přepis workshopu (Information_Model_Workshop.vtt)

---

## 1. Přehled entit

### 1.1 Poptávka

Vstupní entita před vznikem projektu. Projekt z ní vzniká importem ze zdrojového systému.

|Atribut|Poznámka|
|---|---|
|Zdrojový systém|Identifikátor systému, ze kterého poptávka přišla|
|ID ze zdrojového systému|Cizí klíč do zdrojového systému|
|Interní identifikátor|Naše vlastní ID poptávky|

---

### 1.2 Projekt

Hlavní entita portálu výstavby. Každý projekt je přiřazen k územnímu celku (okresu).

|Atribut|Poznámka|
|---|---|
|Název|—|
|ID|Interní identifikátor projektu|
|Typ projektu|Odvozeno z kombinace příznaků (viz níže)|
|SPP prvek|Identifikátor skupiny výdajů (finanční klasifikace)|
|Datum zahájení|—|
|Datum ukončení|Odvozeno od ukončení posledního dokumentu/úkolu|
|RFC datum|„Ready for Customer" – nejzazší datum předání zákazníkovi|
|Administrativní oblast|Okres (územní celek)|
|Režim financování|—|
|Externí objednatel|Reference na entitu Organizace|

**Typy projektu** jsou odvozeny kombinací příznaků:

- Kopání do země (ano / ne)
- Stavební povolení (ano / ne)
- Počet kol investiční komise (IK1 / IK2 / IK3)

> ⚠️ **Otevřená otázka:** Přesná definice typů projektů a výčet kombinací – čeká na zadání od stakeholderů.

---

### 1.3 Program

Nadřazená entita nad skupinou projektů (výstavbové programy). V současnosti málo instancí – detailní atributy zatím nedefinovány.

---

### 1.4 Portfolio

Nejvyšší úroveň hierarchie (Portfolio → Program → Projekt). Synergický pohled – označen jako „exotický" scénář, zatím odložen.

---

### 1.5 Etapa

Fyzické rozdělení projektu po činnostech nebo lokalitách. Etapa není povinná.

|Atribut|Poznámka|
|---|---|
|Název|—|
|Popis|—|
|Datum začátku|Odvozeno od nejdřívějšího úkolu etapy|
|Datum konce|Odvozeno od posledního úkolu etapy|
|Dodavatel|Reference na entitu Organizace (volitelné)|

---

### 1.6 Úkol (Task)

Základní pracovní jednotka. Úkoly jsou generovány ze šablon na základě typu projektu.

|Atribut|Poznámka|
|---|---|
|Název|—|
|ID|—|
|Popis|—|
|Přiřazení (role)|Role, která má úkol splnit (z entitního pohledu)|
|Zodpovědná osoba (accountable)|1 konkrétní člověk – ten, kdo ručí za výsledek|
|Provádějící osoby (responsible)|Více osob – ti, kdo fyzicky práci vykonávají|
|Termín plánovaný|—|
|Termín skutečný|—|
|Stav|—|
|Dodavatel|Organizace, která úkol fyzicky provádí (volitelné)|

> **Rozlišení rolí:**
> 
> - **Accountable** = 1 osoba, ručí za to, že úkol byl správně splněn
> - **Responsible** = 1–N osob, fyzicky provádějí úkol  
>     Z pohledu entitního modelu: úkol patří **roli**, ne konkrétnímu člověku. Přiřazení konkrétní osoby je fyzický/implementační pohled.

---

### 1.7 Milník

Specifický klíčový deadline – ne deadline každého úkolu, ale určitého klíčového bodu projektu (např. RFC, konec IK).

|Atribut|Poznámka|
|---|---|
|Název|—|
|Popis|—|
|Datum plánované|—|
|Datum skutečné|—|
|Typ|`interní` / `externí` / `soukromý`|

> RFC (Ready for Customer) je klíčovým milníkem. Úkoly jsou kaskádově navázány na milníky – RFC určuje nejzazší termín pro odevzdání zákazníkovi.

---

### 1.8 Baseline (Základní plán)

Snapshot stavu projektu (úkolů) k určitému datu. Umožňuje porovnání: původní plán vs. aktuální plán vs. realita (např. Q1 vs. Q2 vs. aktuální stav).

|Atribut|Poznámka|
|---|---|
|Projekt|Reference|
|Datum snapshotování|Kdy byl baseline pořízen|
|Popis / label|Volitelná anotace (např. „prezentováno vedení Q1 2025")|

> **Rozhodnutí:** Baseline = `entita Projekt k datu` – celý snapshot se uloží jako jeden záznam (nikoliv auditní log jednotlivých polí). Tím je možné koordinovaně porovnávat stav k různým datům.

---

### 1.9 Investiční komise (IK)

Schvalovací proces investic. Může proběhnout až ve třech kolech (IK1, IK2, IK3).

|Atribut|Poznámka|
|---|---|
|Kolo IK|IK1 / IK2 / IK3|
|Datum|—|
|Výsledek|`schváleno` / `zamítnuto`|
|Členové|Seznam členů s jejich vyjádřením (`souhlasí` / `nesouhlasí` / `čeká`)|

> **Implementační poznámka:** IK je realizována jako sada úkolů v projektu, nebo jako záložka s tabulkou nákladových položek. Každý člen komise dostane vlastní úkol (vyjádřit se). Jakmile se všichni vyjádří kladně → IK přechází do stavu „schváleno". Při zamítnutí → návrat do příslušných procesních kroků.

---

### 1.10 Nákladová položka (CAPEX)

Kapexové náklady přiřazené k projektu a schvalované v rámci IK.

|Atribut|Poznámka|
|---|---|
|Plánovaná částka|„Navrhovaná" částka|
|Skutečná částka|Reálně utracená / potvrzená|
|Stav|`navrhovaná` / `potvrzená` / `zamítnutá`|

---

### 1.11 Dotační žádost

Evidence dotací přiřazených k projektu.

|Atribut|Poznámka|
|---|---|
|Kód / ID dotace|Identifikátor přidělený státem|
|Datum platnosti od|—|
|Datum platnosti do|—|

---

### 1.12 Územní celek (Administrativní oblast)

Nositel defaultního přiřazení rolí. Projekty jsou vždy zadávány na úrovni okresu.

|Atribut|Poznámka|
|---|---|
|Název|—|
|Typ|Okres / kraj / jiný celek|
|Členové týmu (přiřazení)|Historizovaná vazba: osoba – role – od – do – hlavní/vedlejší|

> Pro každý územní celek existuje v daném čase právě **1 hlavní osoba dané role** (např. hlavní plánovač okresu). Přiřazení je historizované (od–do).

---

### 1.13 Příloha / Soubor

Reference na dokument uložený v externím úložišti (SharePoint, file storage).

|Atribut|Poznámka|
|---|---|
|Název souboru|—|
|Účel / typ dokumentu|Např. DSPS, stavební povolení, harmonogram, world/excel|
|Zdroj|Odkud soubor přišel|
|Cíl|Komu / kam je soubor určen|
|Reference / URL|Odkaz do SharePointu nebo interního file storage|

> Příloha může být přiřazena k projektu, etapě nebo úkolu.

---

### 1.14 Uživatel (User)

Interní uživatel systému – provádí akce v portálu.

---

### 1.15 Kontakt / Fyzická osoba

Externí kontakt (nezávislý na účtu v systému).

|Atribut|Poznámka|
|---|---|
|Jméno|—|
|Datum narození|—|
|Kontaktní údaje|—|

---

### 1.16 Organizace / Firma

Dodavatel, zákazník, objednatel nebo jiný subjekt. Přiřazuje se k projektu, etapě nebo úkolu.

|Atribut|Poznámka|
|---|---|
|Název|—|
|Typ vztahu|Dodavatel / zákazník / objednatel|

---

### 1.17 Role na projektu

Přiřazení konkrétní osoby ke konkrétní roli na projektu (historizovaná vazební tabulka).

|Atribut|Poznámka|
|---|---|
|Projekt|Reference|
|Uživatel / Kontakt|Kdo roli zastává|
|Role|Hlavní plánovač / PC / disviz / ...|
|Od|—|
|Do|—|
|Hlavní / vedlejší|Boolean příznak|

---

## 2. Hierarchie entit

```
Portfolio
  └── Program
        └── Projekt
              ├── Etapa (volitelná, 0–N)
              │     └── Úkol (N)
              ├── Úkol (mimo etapu, N)
              ├── Milník (N)
              ├── Baseline (N)
              ├── Investiční komise (0–3)
              │     └── Nákladová položka (N)
              ├── Dotační žádost (0–N)
              ├── Příloha (N)
              └── Role na projektu (N)

Územní celek
  └── Role / přiřazení lidí (historizovaná vazba)

Organizace
  └── Přiřazení k Projektu / Etapě / Úkolu

Kontakt / Fyzická osoba
  └── Přiřazení k Projektu / Úkolu (Responsible / Accountable)
```

---

## 3. Klíčová rozhodnutí

|#|Rozhodnutí|Stav|
|---|---|---|
|D1|Baseline = samostatná entita (snapshot projektu k datu), nikoliv historizace auditního logu|✅ Rozhodnuto|
|D2|Milník ≠ deadline každého úkolu; milník = klíčový bod (RFC, konec IK kola)|✅ Rozhodnuto|
|D3|Accountable = 1 osoba; Responsible = N osob|✅ Rozhodnuto|
|D4|Z pohledu entitního modelu: úkol patří **roli**, ne konkrétnímu člověku|✅ Rozhodnuto|
|D5|Územní celek je samostatná entita – nese defaultní přiřazení rolí|✅ Rozhodnuto|
|D6|IK je implementována jako sada úkolů nebo záložka s tabulkou nákladových položek|✅ Rozhodnuto|
|D7|Příloha může být přiřazena k projektu, etapě i úkolu|✅ Rozhodnuto|
|D8|Organizace (firma) je samostatná entita – může být dodavatel na úrovni projektu, etapy i úkolu|✅ Rozhodnuto|
|D9|Model bude uložen do GitLabu; nejdřív strukturované poznámky, pak diagram|✅ Dohodnutý postup|

---

## 4. Otevřené otázky (Open Points)

Viz samostatný dokument: **Portál výstavby – Open Points**.