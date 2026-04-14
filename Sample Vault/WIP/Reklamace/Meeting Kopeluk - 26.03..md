> v tomhle záznamu je spousta chyb a šumu, spíš manuálně projít a zkonsolidovat jestli máme něco nového / co by stálo za to převzít a doplnit ke zbytku ----- nezapomínej nahrávací JABRU
# Shrnutí konverzace: Reklamace – z procesu do komerce vs. reklamace služeb

**Délka:** cca 53 minut  
**Kontext:** Schůzka zaměřená na pochopení procesu reklamací v rámci FTTH výstavby – jak fungují reklamace v průběhu předávání do komerce a jak se liší od reklamací po zřízení služby. Konverzace má charakter discovery interview s doménovým expertem (FTTH manažer / příprava služeb).

---

## 1. Úvod a motivace schůzky

Schůzka byla svolána proto, že současná implementace reklamací v Portálu výstavby (M365) není robustní a jakékoli úpravy stávajícího řešení jsou rizikové. Nový centrální product owner (Standa) nahradil předchozí trojici PO. Účastníci potřebují porozumět celému životnímu cyklu reklamací, protože dosud slyšeli různé verze toho, jak by to mělo fungovat, a nikdo ze současného osazenstva se na to dostatečně neptal.

Klíčový akutní problém: **filtry v M365 nefungují** – při 700+ záznamech nelze filtrovat podle krajů/okresů, což blokuje práci KPS 4 a KPS 1 (regionálně rozdělenou). Řešení filtrů je v procesu.

---

## 2. Životní cyklus ROPKY – cesta do komerce (happy path)

Popsaná časová osa od výstavby po komerční provoz:

1. **Výstavba** – Projektový koordinátor (PC) rozdělí práci na etapy (liniové etapy, vnitřní rozvody). Po dokončení sady ropek je prohlásí za kompletní a vytvoří **dílčí dodávku**.
    
2. **KPS 4 (Network Inventory)** – Přijme dílčí dodávku, zapisuje data do network inventory systémů. Vytváří numerický model sítě na základě dodané dokumentace (DFAS/SRO). Nekontroluje dokumentaci – rovnou zapisuje. Pokud něco chybí, vrací PC.
    
3. **KPS 1 (Příprava pracovních příkazů)** – Vypracuje **pracovní příkaz** (návod jak propojit síť), zapíše název pracovního příkazu do M365 (jediná spojnice mezi M365 a ZIS). Pracovní příkaz se zapisuje do **ZIS**.
    
4. **Dispečer** – Řídí FMM techniky přes ZIS. Dispečer ani M365/VCRM nemají žádnou roli – jsou řízeni přes ZIS. Technici jsou **jediní, kdo fyzicky dorazí na místo**.
    
5. **Výstupní kontrola (= oddělení Příprava služeb)** – Kontroluje v M365, zda jsou pracovní příkazy uzavřené (den předtím/v ten den). Kontroluje numerický model, fotografie z výstavby, fotografie z FMM. Čistě **kontrolní role** – nevykonávají, jen ověřují. Pokud vše OK, posílají ropku na **FTTH manažera** ve stavu „ke odkepování".
    
6. **FTTH manažer** – Podle obchodních pravidel (fixních i **ad-hoc**) stanoví datum vstupu do komerce. Klíčové pravidlo: minimálně **30–35 dnů** předem (aby obchodní partneři mohli reagovat). Den X-1 příprava služeb „podstapovává" (odkepuje).
    
7. **Vstup do komerce** – 30 dnů předem se ropka zviditelní obchodním partnerům. 7 dnů předem se sjednávají termíny se zákazníky. V den D se objednávky vysypou do realizace. Služba se zřizuje automaticky podle numerického modelu sítě – technik pouze připojí modem.
    

---

## 3. Typy reklamací – hlavní taxonomie

Identifikovány **dvě hlavní kategorie**:

### 3.1 Reklamace z procesu do komerce („produkce")

Vznikají v průběhu kroků 2–6 výše. Každý článek řetězce může zjistit chybu a vrátit to zpět.

**Četnost dle místa vzniku:**

- **#1 (nejčastější):** KPS 4 → reklamuje na výstavbu (chybějící/neúplná dokumentace)
- **#2–3:** Výstupní kontrola → reklamuje na kohokoliv před sebou
- **#4–5:** KPS 1 a dispečer → reklamace v ZIS

**Typický flow reklamace:**

- KPS 4 zjistí chybějící dokumentaci → vrátí PC → PC zajistí od dodavatele → doplní → vrátí KPS 4
- Dispečer (technik v terénu) zjistí chybějící splitr → zapíše do ZIS → příprava služeb si to vezme a řeší
- Každý subjekt, co zjistí chybu, většinou ví, komu to poslat (zkušení pracovníci). Výstavba to často neví (neznají follow-up procesy).

### 3.2 Reklamace po objednávce / po zřízení služby („postprodukce")

Vznikají kdykoliv poté, co je ropka v komerci – klidně i **3–4 roky** po předání. Příčiny:

- Nikdo si na ropce dosud neobjednal službu, takže se na chybu nepřišlo dříve
- Vnější události (např. rekonstrukce stoupaček v domě – SVJ uřízne kabely, CETIN musí stavět znova)
- Rozhodnutí o opravě je **obchodní** (ne technické) – obchodník rozhodne, zda se vyplatí znovu investovat

Tato kategorie dosud **nemá systemovou podporu v M365** – řeší se přes VCRM / trouble tickety. Pan Michal identifikoval potřebu oba typy sjednotit ideálně v jednom systému.

---

## 4. Směrování opravených reklamací

- Reklamovaný subjekt (typicky výstavba) opraví závadu a posílá opravenou reklamaci dál
- Zkušení pracovníci vědí, kam to poslat; nováčci ne (zaškolení trvá cca rok)
- Výstavba často nerozumí návazným procesům (neví, proč musí dodávat dokumentaci, neznají numerický model sítě)
- Oprava může znamenat změnu numerického modelu → nový/opravený pracovní příkaz → znovu celý cyklus propojování
- Systém by **neměl** automatizovat routing reklamací – nedá se jednoduchou logikou určit, kam to patří; jde o expertní rozhodnutí

**Ověření výsledku reklamace:** V M365 existuje checkbox „chci ověřit výsledek" – pokud ho reklamující zaškrtne, opravená reklamace se mu vrátí ke schválení. Tento mechanismus **není povinný**, ale měl by být (analogie s finančním sektorem – zadavatel reklamace by měl finálně potvrdit).

---

## 5. Kategorie a druhy reklamací – problematický návrh

KPS 4 požadovala přidání kategorií a důvodů reklamací (pro reporting). Návrh vytvořila paní Jíšová. Kategorie:

**Druh reklamace:** dokumentace přívodu / dokumentace VR / obojí / provedení přívod / provedení VR / obojí / jiná závada

**Důvod reklamace:** rozpory v dokumentaci / neúplná dokumentace / není vložena dokumentace / provedení přívod / provedení VR / ...

**Problém:** Kombinace druh + důvod jsou často **redundantní nebo nesmyslné** (např. druh „provedení přívod" + důvod „provedení přívod"). Nikdy z toho nebyl dělaný report, takže nikdo netuší, jestli tyto kategorie poskytnou užitečné informace. Motivace: pan Pešek prohlásil, že vše zdržuje KPS 4, tak si KPS 4 chtěla reportovat, co konkrétně zdržuje výstavba.

**Akce:** Potřeba sejít se s paní Jíšovou a dalšími, aby se zjistilo, co přesně chtějí z reportů vidět, než se kategorie implementují.

---

## 6. Systémová krajina a provázanost

|Systém|Role|
|---|---|
|**M365 (Portál výstavby)**|Hlavní systém pro řízení výstavby, fronty, stavy ropek, reklamace|
|**VCRM**|Starší systém – obsahuje ropky + dokumentaci; plánovaná migrace|
|**ZIS**|Řízení pracovních příkazů, dispečink FMM techniků|
|**Network Inventory**|Numerický model sítě (DFAS/SRO)|
|**ISRM**|Starý systém, kde byly oba typy reklamací pohromadě|

Klíčové propojení: Název pracovního příkazu v M365 je **jediná** spojnice s ZIS. Bez něj nelze dohledat, jakým pracákem byla síť propojena.

---

## 7. Migrace dat z VCRM

Potřeba přemigrovat ropky z VCRM do M365, protože:

- Přes M365 potečou ropky od letošní výroby dál, ale starší ropky (loni a dříve) tam nejsou
- Reklamace po objednávce na starou ropku (třeba 4 roky) nebude mít kde být zadána
- Dokumentace (fotky, protokoly) by měla být dostupná v novém systému
- Bratrovského tým říká, že dokumentaci migrovat nebudou – nechají ji v VCRM s prostupem (VCRM bude provozováno desítky let)
- Chybí cca ¾ roční výstavba, cca 500 HP z roku 2020+

---

## 8. KPI a objem reklamací

- V prosinci pan Pešek slíbil opravu 1800 HP do 15. ledna
- Na konci února stále **přes 2000 reklamací** otevřených
- KPI zatím nelze efektivně sledovat kvůli nefunkčním filtrům
- Potřeba reporting nastavit smysluplně – aktuální stav je ad-hoc

---

## 9. Klíčové otevřené body a doporučení z konverzace

- **Filtry v M365** – kritický blokér, řeší se aktuálně
- **Kategorizace reklamací** – přehodnotit navržené kategorie s business stakeholdery, než se implementují
- **Povinnost ověření** – zvážit povinný checkbox „chci ověřit výsledek" pro všechny reklamace
- **Reklamace po objednávce** – dosud bez systémové podpory v M365; potřeba designu
- **Migrace VCRM** – nutná pro pokrytí starších ropek; rozhodnout o strategii dokumentace
- **Routing reklamací** – neautomatizovat; ponechat na expertním rozhodnutí pracovníků
- **Kontakty pro další zjišťování:** pan Kalous (příprava služeb), Martin Dvořák (trouble tickety po záruce)