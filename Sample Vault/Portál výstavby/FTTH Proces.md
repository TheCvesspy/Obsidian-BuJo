- Přehled ROPID - duplicita co se nepoužívá (asi)
- akvizice - další věc co se prý nepoužívá
- 

### Založení projektu

- v realitě by mělo jít integrací z SVS (a aktuálně dojde k přesunu do Evaluation modelu)
- KIA nemůže mít vazby 1:N
	- každý projekt musí mít unikátní KIA
- Šablona termínů
	- z interního číselníku, dle různé datumové priority
- Typ investice - vazba na účetní systém
	- primárně jde z integrace
- Požadované RFC #ověrit_nutnost
	- v FTTH je povinné, ale není (jelikož ho stejně přepíše šablona)
	- v FTTH je to "zbožné přání" - možná funguje v nějakém reportingu (ověřit zda je to někomu k něčemu)
- Okres ...
- Cetin Příznak
	- shluk různých businesových specifikací
	- určeno k náhradě, míchá to domény mezi sebou
	- vznikne nová "kategorizace"
- popis k integraci je u Pavla Vaníčka
	- není to live integrace, je to odečítání přírůstkovým scriptem, který si pak porovnává data
	- SVS
	- projít s Pavlem, jak to vypadá a k čemu to je

### Step 1A - Investice (manuální krok)
- zatím není automatizováno a dělá se to ručně
- chybí integrace
- adept na náhradu automatizací

### Step 2 - Příprava startovací dokumentace
- automaticky předá na hlavního plánovače okresu (a změní vlastníka projektu v kroku)
- jediné co dělá je, že najde pole
