## Reklamace - KPS4 - Brož

Druh reklamace:
	“Dokumentace Přívod” - KPS4
	“Dokumentace VR” - KPS4
	“Dokumentace Přívod a VR”; - KPS4 
	“Provedení Přívod”; - KPS4
	“Provedení VR”; - KPS4
	“Provedení Přívod a VR”; - KPS4 
	“Jiná závada”; 
	“Reklamace po objednávce - Přívodní kabel MSO”; 
	“Reklamace po objednávce - Přívodní kabel VSO linie”; 
	“Reklamace po objednávce - Přívod do bytu VSO”; 
	“Reklamace po objednávce - Vnitřní rozvody VSO”; “Reklamace po objednávce - jiné”
Důvod:
	“V1 - rozpory v dokumentaci”;- kps1/4
	“V2 - není vložena dokumentace”; - kps1/4
	“V3 - neúplná dokumentace”; - kps1/4
	“V4 - vráceno na žádost PC”; - kps1/4
	“V5 - nedostatek vláken”; - kps1/4
	“V6 - nedokončená výstavba OLT”; - kps1/4
	“RVK1 - dokumentace přívod”; 
	“RVK2 - provedení přívod“; 
	“RVK3 - provedení VR”; 
	“RVK4 - provedení přívod a VR”; 
	“RVK5 - jiná závada”; 
	“RVK6 - dokumentace VR”; 
	“RPO1 - původní kabel - MSO”; 
	“RPO2 - původní kabel - VSO”; 
	“RPO3 - přívod do bytu - VSO”;
	“RPO4 - vnitřní rozvody - VSO”; 
	“RPO5 - jiná závada”
Důvodů může být více (typicky 2 věci naráz - přívod + rozvody??)

# Shrnutí schůzky: Reklamace v procesu ROP do komerce

**Datum:** (z transkriptu)  
**Účastníci:**

- **Analytický tým (Portál výstavby):** Ondřej Cvešpr (analytik), kolega (přebírá roli centrálního produktu nad portálem výstavby), Standa (kolega, krátce přítomen)
- **KPS4 (evidence FTTH do inventory):** Jaroslav Brož
- **KPS1 (pracovní příkazy, provoz):** Pavel Kadlec
- **Omylem přizván:** Petr Dvořák (jiný Dvořák než Martin Dvořák z výstupní kontroly)
- **Nepřítomen:** pan Kopeluk (plánována separátní schůzka)

---

## 1. Kontext a účel schůzky

Analytický tým provádí **druhé kolo sběru požadavků** na proces reklamací v rámci ROP do komerce. Původní analýza (vedená panem Bartovským a Opluštělem) se ukázala jako nedostatečná — objevily se protichůdné informace a bílá místa. Cílem schůzky je pochopit proces z pohledu KPS4 a KPS1, zmapovat požadavky a připravit podklady pro portál výstavby (M365).

Kromě reklamací v procesu ROP do komerce existuje ještě **druhý typ reklamací** — reklamace po předání ROPek do komerce (provozní reklamace). Ty řeší Martin Dvořák a Pavel Kučera a analytický tým plánuje je rovněž převzít pod portál výstavby.

## 2. Role KPS4 a KPS1 v procesu

### KPS4 (Brož) — hlavní „síto" kvality

- **Eviduje do inventory** FTTH prvky: kabely, splitry, vnitřní rozvody.
- **Přijímá dílčí dodávky** od stavebních firem a kontroluje dokumentaci (protokoly vnitřních rozvodů, vláknová schémata, tabulky SDF apod.).
- **Je primárním zadavatelem reklamací** — odhaluje většinu problémů hned na začátku.
- Při nalezení nesouladu **zakládá reklamaci a vytváří úkol**, který posílá zpět na stavbu (přes PC / zhotovitele).
- Filtruje reklamace **podle krajů/rajonů**.
- Po opravě a doevidování posílá reklamaci dál (buď na KPS1, nebo přímo na výstupní kontrolu, pokud se KPS1 netýká).

### KPS1 (Kadlec) — pracovní příkazy a provozní zajištění

- Vydává **pracovní příkazy** (SLA cca 24 hodin).
- Reklamuje **méně často** — většinu problémů odchytí KPS4.
- Reklamuje hlavně v případech zjištěných při zapojování v terénu: chybějící splitry, špatné provedení, neodpovídající stav.
- Reklamace z KPS1 typicky směřují **na KPS4** (aby doevidovali), nikoliv přímo na stavbu.
- Definoval s paní Jíšovou **číselník důvodů reklamací** (cca 7–8 primárních důvodů).

## 3. Průběh reklamačního procesu (AS-IS)

1. **KPS4 obdrží dílčí dodávku** → otevře, zkontroluje dokumentaci.
2. **Pokud je problém** (chybí protokoly, neúplná/odporující si dokumentace) → **založí reklamaci** s druhem a důvodem.
3. **Reklamace putuje na stavbu (PC)** → PC kontaktuje zhotovitele, ten opravuje.
4. **Zhotovitel vrátí opravenou dodávku** → KPS4 doeviduje a posílá dál.
5. **Pokud jde o věc týkající se KPS1** (např. splitry pro provoz) → reklamace projde přes KPS1.
6. **Pokud se KPS1 netýká** (90 % případů u opakovaných reklamací) → KPS4 posílá **přímo na výstupní kontrolu** (Kučera/Dvořák), čímž přeskakuje KPS1.
7. **Výstupní kontrola ověří** a reklamaci **uzavře**.
8. **Vždy platí:** reklamaci uzavírá ten, kdo ji založil.

### Odmítnutí reklamace

- Pokud řešitel vrátí reklamaci jako vyřešenou, ale **kvalita je nedostatečná**, řešitel na straně CETIN ji **odmítne** → měla by se vrátit zpět na řešitele/zhotovitele.
- Reklamace se **opakovaně vrací** (i 8× u problematických dodavatelů).
- **Nová reklamace se nezakládá** — pokračuje se v původní.

## 4. Druh a důvod reklamace (číselník)

### Druh reklamace (co se reklamuje)

- Dokumentace — přívod
- Dokumentace — VR (vnitřní rozvody)
- Dokumentace — přívod a VR
- Provedení — přívod
- Provedení — přívod a VR
- Jiná závada
- _(Reklamace po objednávce — řeší Dvořák/Kučera, mimo scope KPS4)_

### Důvod reklamace (podmnožina druhu, vždy 1 důvod)

- Dokumentace kompletně chybí
- Dokumentace neúplná (chybí tabulky SDF, schémata)
- Dokumentace si odporuje
- Protokoly vnitřních rozvodů nevloženy
- Chybí splitry / špatné osazení
- Provedení neodpovídá (dle fotek)
- Jiná závada → vyžaduje povinný textový popis

### Mapování na role

- **KPS4** typicky: dokumentace přívod, dokumentace VR, dokumentace přívod a VR, provedení přívod, provedení přívod a VR
- **KPS1** typicky: provedení (splitry, zapojení), méně časté
- **Výstupní kontrola** (Dvořák, Kučera): reklamace po objednávce, provozní zjištění

## 5. Požadavky a náměty na portál výstavby

### Vysoká priorita (funkční požadavky na reklamace)

|#|Požadavek|Zdroj|
|---|---|---|
|1|**Povinná poznámka při řešení reklamace** — řešitel musí popsat, co udělal (aby následující článek nemusel „hledat 7 rozdílů")|KPS1 (Kadlec)|
|2|**Číselník druhu a důvodu reklamace** s filtrací dle role (KPS4 vidí své, KPS1 své) — ne celý seznam pro všechny|KPS4 + KPS1|
|3|**Kategorie „Jiná závada" vyžaduje povinný popis**|Analytik|
|4|**Odmítnutá reklamace se musí vrátit k řešiteli** — aktuálně zůstává „viset" u odmítajícího|KPS4 (Brož, příklad s kolegou Hůlkou)|
|5|**Možnost přeskočit krok v procesu** (přímá vs. standardní cesta) — pokud KPS4 ví, že se KPS1 netýká, poslat rovnou na výstupní kontrolu. Výchozí stav = standardní kolečko, přeskočení jako volitelná akce.|KPS1 (Kadlec)|

### Střední priorita (UX / usability)

|#|Požadavek|Zdroj|
|---|---|---|
|6|**Proklik z reklamace na zdrojový projekt / dílčí dodávku** — dnes nutno ručně přecházet mezi okny|KPS1 (Kadlec)|
|7|**Proklik na přílohy (dokumentaci)** přímo z reklamace|KPS4 (Brož) + KPS1|
|8|**Počet ROPek v hlavičce reklamace** — dnes je vidět až po odscrollování dolů|KPS1 (Kadlec)|
|9|**Filtry dle krajů/rajonů** — nedávno zprovozněny, ale ještě nedoladěny|KPS4 (Brož)|
|10|**Rychlost načítání příloh** — portál je podstatně pomalejší než CRM|KPS4 (Brož)|

### Nižší priorita (reporting / statistiky)

|#|Požadavek|Zdroj|
|---|---|---|
|11|**Statistiky reklamací:** počet dle druhu/důvodu, doba řešení, počet opakovaných vrácení, rozpad dle zhotovitelů|KPS1 (Kadlec)|
|12|**SLA metriky** — sledování, jak rychle se reklamace prochází jednotlivými kroky (jako obrana při argumentaci na konci roku)|KPS1 (Kadlec)|
|13|**Reporting pro vedení / vyjednávání se zhotoviteli** — data pro sankce, slevové akce, změnu zhotovitele|KPS1 (Kadlec)|
|14|Kontaktní osoba pro reporting: **Jitka Jíšová** (šéfová Brože, zaštiťuje KPS4 + KPS2, měla reporty v CRM)|KPS1 (Kadlec)|

## 6. Porovnání CRM vs. Portál výstavby

- V CRM existovala **historie reklamace** s kompletním logem (kdo, kdy, co udělal).
- CRM mělo **druh reklamace** (ale ne důvod — ten byl požadován a přidáván).
- V CRM **poznámka nebyla povinná** → stejný problém jako dnes.
- Portál výstavby je **pomalejší** při načítání příloh.
- Filtry dle krajů v portálu **začaly fungovat teprve nedávno** (den před schůzkou).
- Problém s **blokováním maker** při stahování Excel protokolů z portálu (hlášeno Bartovskému).

## 7. Rozšíření scope — aktivní technologie (M365)

- KPS1 potvrdil zájem o **sjednocení reklamačního procesu** i pro aktivní technologie (IP boxy, mikrovlny apod.) do jednoho systému (M365).
- Reklamace u aktivních technologií budou **principiálně stejné**, liší se jen v předmětu (hardware místo FTTH prvků).
- Rozhodnutí o M365 vs. jiném systému stále probíhá (Martin Klouček).

## 8. Další kroky

- [x] Separátní schůzka s **panem Kopelkem** (výstupní kontrola / dispečeři). #type/task @due tomorrow
- Problém s odmítnutými reklamacemi nahlásit i **panu Bartovskému**. #type/task @due today
- [ ] Schůzka ohledně **reportingu** — přizvat Kadlece, Brože a hlavně **Jitku Jíšovou**. #type/task @due friday
	- [ ] nejdřív ověřit skrze Pavla Michala, kdo by se případně měl ještě účastnit (Timo), aby reporting byl co k čemu