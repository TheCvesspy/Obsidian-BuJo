# Portál výstavby — Business Intro (shrnutí přepisu)

> **Kontext:** Záznam z úvodního představení Portálu výstavby pro nového člena týmu. Přepis automaticky identifikoval všechny účastníky jako jednu osobu; shrnutí se proto soustředí čistě na informační obsah.

---

## 1. Co je Portál výstavby

Portál výstavby je aplikace postavená nad **Microsoft 365** (Power Apps, Canvas Apps, BPF workflow, parametrizační skripty). Slouží k řízení výstavbových projektů telekomunikační infrastruktury v CETINu.

Pokrývá veškeré technologie:

- **Fyzická vrstva** — výkopy, chráničky, kabely (optické i metalické).
- **Aktivní prvky** — zakončení, rozvaděče, splittery.
- **Mobilní infrastruktura** — BTS věže, antény, rádiové spoje (mikrovlny), optické přívody k věžím.

Cílový stav je, aby Portál výstavby uměl managovat výstavbu **všech** těchto technologií v jednom nástroji.

---

## 2. Typy projektů

|Typ projektu|Zkratka|Popis|
|---|---|---|
|Fibre to the Home|**FTTH**|Budování přístupové optické sítě v obcích — nejsložitější typ, ostatní jsou zjednodušené klony.|
|Zákaznický projekt sítě|**ZPS**|Bod-bod připojení korporátních zákazníků (banky, developer. projekty, administrativní centra).|
|Vynucené překládky|**VPI**|Přeložky tras kvůli střetům se stavbami třetích stran.|
|Standardní (proaktivní) akce|—|Interně iniciované projekty CETINu (např. připojení nových BTS pro pokrytí bílých míst mobilním signálem).|

**Jednokolové vs. dvoukolové projekty:** U jednokolových se po fázi plánování přechází rovnou k realizaci bez legislativní/projektové přípravy (např. zafoukání kabelu do existující plastové infrastruktury). Podpora jednokolových projektů pro všechny typy se plánuje v horizontu cca 2 sprintů.

---

## 3. Hlavní fáze procesu (FTTH jako reference)

### 3.1 Evaluation modul (předplánování)

- Dnes běží v legacy systému **SVS** (Systém výstavby sítě); brzy bude nahrazen modulem přímo v Portálu výstavby.
- Útvar **Strategie** vytváří v **GIS** (grafický inventory) polygony — oblasti plánované výstavby.
- Zamalováním polygonu automaticky vzniká **seznam adres/objektů** (tzv. „robky" — ROB ID z Registru objektů a pracovišť).
- Řeší se: penetrace služeb, konkurence, existující infrastruktura, prvotní odhad nákladů.
- **ABC (Area Business Coordinator)** — regionální pracovníci jednají s obcemi (starosta, zastupitelstvo) o podmínkách: kam CETIN pustí, jestli obec neplánuje vlastní stavební akce (kanalizace, plyn…), kde jsou nové asfalty/chodníky apod.
- Na základě toho se přepočítává byznys case.
- Výstupem evaluace je **IK1** (Investiční komise 1) — schválení finančním kontrolingem, alokace investic v **SAPu** na **SPP prvek**.
- Entita se zakládá i v **CRM** systému (obchodní/strategický vstupní proces).
- Proces může skončit i negativně — projekt nemusí vzniknout.

### 3.2 Plánování (start projektu → IK1 technická)

- Projekt se zakládá integrací z evaluation modulu (dnes z SVS, do budoucna přímo z Portálu).
- **Plánovač** vytváří **startovací dokumentaci** (GPON model) — detailní obraz plánované sítě: kudy povedou kabely, jak budou připojeny objekty, optický přívod, metráže, podzemní/nadzemní spojky, rozvaděče apod.
- Z modelu se kalkuluje **cena díla**, která se blíží realitě.
- Vzniká **koordinační akce** a **dokumentové úložiště** (verzovaný SharePoint).

**Připomínkování startovací dokumentace:**

- Lhůta: **4 pracovní dny**.
- Připomínkovatelé definovaní **per okres** (nepovinní) — plánovači, správci sítě v regionu.
- Notifikace e-mailem / Teams s proklikem na úkol a dokumentaci.
- Pokud se nikdo nevyjádří, automaticky schváleno.
- Po připomínkování spouští nadřízený plánovač **technickou IK1** — automatické volání SAPu, které založí finanční kontejner (SPP prvek) a alokuje investice.

> **Poznámka k terminologii:** „IK1" existuje fakticky dvakrát — jednou jako schvalovací milník v evaluation modulu, podruhé jako technický krok vůči SAPu v Portálu výstavby. Jde o známý terminologický problém, který se plánuje řešit.

### 3.3 Zpracování přípravy (IK1 → IK2)

Typicky **nejdelší fáze** projektu (může trvat i rok a více). Řeší se:

- Oslovení správců inženýrských sítí.
- Oslovení dotčených orgánů státní správy.
- Jednání s majiteli pozemků — smlouvy o smlouvách budoucích (věcná břemena).
- Stavební/územní řízení.
- Vytvoření **projektové dokumentace** (DPS — dokumentace pro provedení stavby).

**Poptávka/objednávka zhotovitelů:**

- Systém umožňuje oslovit zhotovitele přes poptávku, nebo přeskočit poptávku a rovnou objednat (pokud je zhotovitel pro region předvybraný).
- Zhotovitelé mají vlastní **externí aplikaci** (omezený pohled) — fronta poptávek/objednávek, chat s objednatelem, zadávání prognóz termínů.
- Eskalační mechanismus: pokud prognóza překračuje objednaný termín → barevné zvýraznění + notifikace koordinátorovi.
- **Měsíční reportování** — koordinátor projekce vyzve zhotovitele k reportu progresu legislativy, břemen apod.

**Řídící tabulka projekce:**

- Vzniká automaticky přiřazením koordinátora projekce.
- Zobrazuje data z obou stran (interní i zhotovitelská), slouží jako centrální pohled na stav přípravy.
- Vazby na projekt, polygon, dokumentové úložiště.

### 3.4 Připomínkování projektové dokumentace (DPS)

- Lhůta: **10 pracovních dnů**.
- Stejná množina připomínkovatelů jako u startovací dokumentace (natahuje se aktuálně z okresů).
- Dokumentační oddělení zároveň zakládá **předběžný obraz sítě v network inventory** — aby se nad ním mohly generovat pracovní příkazy a uvolňovat adresy do komerčního stavu.
- Při **závažné připomínce** se po uplynutí lhůty vrací do zpracování přípravy → nové kolo připomínkování.

### 3.5 IK2

- PC (projektový koordinátor) kontroluje stav investic — systém graficky zvýrazňuje rozdíly oproti schválené IK1.
- Pokud se náklady zvýšily, probíhá schválení finančním kontrolingem.
- Alokace navýšených financí na SPP prvek → umožňuje objednání realizace.

### 3.6 Realizace etap

**Etapizace:**

- Projekt se dělí na **etapy** — liniové (výkopy, kabely) a vnitřní (rozvody v budovách).
- Etap může být 1–N; každá má vlastní termíny, vlastní seznam objektů (ROB ID), vlastní kroky.
- Termíny etap nesmí překročit termíny projektu (systémově hlídáno).
- U ZPS projektů etapizace neexistuje — kroky realizace jsou přímo na hlavním BPF.

**Kroky liniové etapy:**

1. **Určit VIZ** — přiřazení odpovědného PC / zhotovitele.
2. **Předání staveniště** — fyzické předání, podpis protokolu.
3. **Realizace** — samotné výkopové práce, pokládka, propojení. V tomto kroku je možnost spustit sub-proces **„data KPS"** (Kapacitní plánování služeb) — odeslání dílčí dokumentace dokumentačnímu pracovišti, které potvrdí propojení a uvolní adresy do komerčního stavu.
4. **Zpracování DSPS** — dokumentace skutečného provedení stavby (geodetické zaměření, fotky, měřicí protokoly, přesné trasy a metráže).
5. **Akceptace DSPS** — menší skupina akceptovatelů (povinné dokumentační oddělení). Při zamítnutí se vrací do zpracování DSPS. Dokumentační oddělení finalizuje zápis do network inventory (datového i grafického).
6. **Přejímkové řízení** — potvrzení, že stavba je v pořádku, řešení případných reklamací, přejímka do provozu.

**Kroky vnitřní etapy** (rozvody v budovách): pouze kroky 1–3 (určit VIZ, předání staveniště, realizace).

### 3.7 Finanční a majetkové vypořádání

- Nastává po dokončení **všech etap** (systém nedovolí opustit krok realizace, dokud nejsou všechny etapy ukončeny).
- Zatřídění majetku, proplacení faktur, uzavření SPP prvku vůči SAPu.
- Možnost volby: úplné / částečné (bez VB) / částečné vypořádání.
- **Věcná břemena** se mohou řešit dodatečně (zvkladování do katastru) — pokud jsou jen částečně vypořádaná, zobrazí se dodatečné BPF kroky pro dokončení.
- Dílčí finanční vypořádání etap probíhá průběžně mimo Portál; tento krok je finální uzavření za celý projekt.

### 3.8 Ukončení projektu

- PC kontroluje, že jsou uzavřeny všechny úkoly.
- Technické uzavření projektu v systému.

### 3.9 Dotační modul (vize)

- Dnes řešen izolovaně mimo Portál.
- Vize: samostatný modul Portálu výstavby, který přebere hotový projekt s dotačním financováním a odřídí dotační proces.

---

## 4. Klíčové role

|Role|Popis|
|---|---|
|**Plánovač**|Vytváří startovací dokumentaci (GPON model), spouští připomínkování.|
|**Hlavní plánovač**|Nadřízený plánovači; kontroluje a spouští technickou IK1.|
|**Projektový koordinátor (PC)**|Řídí realizaci, přiřazuje zhotovitele, koordinuje etapy, spouští IK2.|
|**Koordinátor projekce**|Řeší legislativní a projektovou přípravu mezi IK1 a IK2 (územní řízení, břemena, projektová dokumentace).|
|**ABC (Area Business Coordinator)**|Jedná s obcemi o podmínkách výstavby v rámci evaluation procesu.|
|**Projektový manažer** (jen ZPS)|Komunikuje se zákazníkem a obchodem, „honící pes".|
|**Koordinátor VB**|Věcná břemena — řeší smlouvy s majiteli pozemků.|
|**Optický správce**|Odpovědnost za část sítě v daném okrese.|
|**Vedoucí investiční zakázky (VIZ)**|Role z nové optiky; zodpovědnost za investiční zakázku (výstavbu).|
|**Dokumentační oddělení (DTU)**|Zápis do datového network inventory.|
|**Technická dokumentace**|Zápis do grafického inventory (GIS).|
|**KPS**|Kapacitní plánování služeb — správci sítě, odpovědní za data o tom, kde co „svítí".|

**Konfigurace rolí:** Role, připomínkovatelé a akceptovatelé jsou definováni na úrovni **okresů**. Praha je řešena jako městské části (kvůli hustotě sítě a rozdílným odpovědnostem).

---

## 5. Uživatelé

Portál výstavby rozlišuje dvě skupiny uživatelů:

### Primární uživatelé

Aktivně pracují s projekty a posouvají proces:

- Plánovači
- Projektoví koordinátoři (PC)
- Koordinátoři projekce
- Zhotovitelé (externí uživatelé s omezenými právy — vidí jen projekty své firmy)
- Dokumentaristé
- Pracovníci nové optiky

### Sekundární uživatelé

Konzumují data a reporty, ale nezajímá je podoba aplikace:

- Manažeři regionů
- Velcí koordinátoři
- Finanční kontroling
- Klíčová metrika: **homepass** (HP) — připojitelná domácnost/komerční prostor; management sleduje kolik HP měsíčně přibývá.

---

## 6. Technické a organizační postřehy

### BPF omezení

- Workflow (Business Process Flow) je **striktně lineární** — neumí paralelní větvení.
- Vracení v procesu je možné jen v omezeném rozsahu (např. hlavní plánovač může vrátit plánovači).
- Evaluation modul toto částečně řeší přes **podmíněné úkoly** místo klasického BPF.
- BPF má **limit na počet objektů** v procesní ose, což omezuje rozšiřování o další varianty.

### Terminologický chaos

- „IK1" existuje dvakrát (evaluation modul vs. technický krok vůči SAPu).
- Milníky mají nekonzistentní význam — procesní vs. reportingový.
- Terminologie převzatá z legacy systémů (20+ let zvyklostí uživatelů).

### Legacy zátěž

- Formuláře převzaly strukturu z obrovských Excelů (stovky atributů, záložky).
- Uživatelé vidí téměř vše téměř vždy — komplikuje orientaci.
- Předchozí špatná zkušenost se systémem SVS (nepřehledné dashboardy, kilometrové formuláře, ztráta orientace v procesu).

### Reporting a data

- Data z BPF kroků se vylévají do „krycího listu" — audit běhů včetně opakování.
- Snapshoting projektů pro BI reporting naráží na objem (50 000 projektů × denní snapshoty = desítky GB).
- Microsoft si účtuje za datové úložiště.

### Licencování

- Aktuálně per-app licence (Power Apps).
- Směřuje se k **per-user licencím** (Microsoft plánuje zrušit per-app do cca 2 let).
- Při 2000+ uživatelích je per-user cenově výhodnější.
- Celkový počet uživatelů: stovky až tisíce (ne všichni konkurentní).

### Notifikace

- E-mail i Teams (Microsoft 365 nativní integrace).
- Uživatelé si mohou parametrizovat vlastní notifikační pravidla.
- Systémové notifikace při změně vlastníka záznamu.

---

## 7. Vize a plánované změny

- **End-to-end orchestrace** celého procesu — od evaluace přes výstavbu po dotace.
- Nahrazení legacy systému **SVS** evaluation modulem v Portálu výstavby.
- Napojení evaluation modulu na **CRM** (byznys case aplikaci).
- **Nová architektura** — překonání limitů BPF (paralelní větvení, flexibilnější workflow).
- **Jednokolové projekty** pro všechny typy (priorita od nové optiky i plánovačů).
- Zjednodušení formulářů a redukce zbytečných atributů.
- Standardizace procesů — přechod z „vím, že mám proces, dělám ho ad hoc" na „budeme ho dělat takhle" (capability maturity model).
- **Doménový entitní model** — BA tým pracuje na zaškatulkování pojmů a entit, aby existoval společný jazyk mezi byznysem, BA a vývojem.

---

## 8. Byznysový model (kontext)

CETIN staví síťovou infrastrukturu a **pronajímá ji providerům** (O2, T-Mobile, Vodafone aj.). Klíčová metrika je **homepass** — počet připojitelných domácností/komerčních prostor. Finance počítají náklady na homepass na koruny přesně, proto musí být odhady materiálu a metráží v dokumentaci velmi přesné (i když skutečnost se pak na stavbě může mírně lišit a proplatí se reálná spotřeba).

**Nová optika** je samostatný subjekt (branding mimo CETIN) zaměřený na nabízení služeb přímo koncovým zákazníkům / providerům, aby se odlišil od historické značky „SPT Telecom → Český Telecom → O2 → CETIN".