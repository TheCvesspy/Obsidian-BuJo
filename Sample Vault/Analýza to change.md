## Technicky

Co chybí jsou základní overview dokumenty:
- entity model
- centrální místo pro dokumentaci
- rozdělení business vs. IT analýza
	- pobavit se i s Janou co je vize
- formáty dokumentace a propojení dokumentace a JIRA

## Komunikace

- mezi analytiky napříč týmy není komunikace
- zahrnovat testing dříve do procesu
	- testy a analýza by měli vznikat ideálně souběžně
	- nejpozději testery zahrnout při refu
- chce to asi i 121 synchro s lead testerů - mělo by to být ideálně na stejné notě
-

ETOM standard - pro TELCO společnosti (seznámit se a ukázat si)
## Rozhovor - Krajíček Michal 27.02.2026 - AS-IS Analysis

- spravuje primárně satelitní aplikace a okrajová témata (specialitky)
- např. Akvizice
	- primárně prostě tráví hromadu času tím, že se snaží protlačovat topicky skrze top/middle management
	- nechce řešit prioritizace a hádání

Začíná businessovou potřebou - ve chvíli, kdy jí dostane do zformalizované podoby. 

To co aktuálně dělal je více "task driven process" - následně dělá prototyp, udělá epicky pro kluky tak aby to dávalo smysl.

1. Procesní model
2. Datový model
3. Formuláře
4. Funkcionality
5. Migrace

-> v podstatě pomáhá analytikům rozporcovat téma na dílčí celky

Podpora uživatelů, školící materiály atd. (ideálně aby to nemusel dělat sám, chtěl by zapojení testera). Go2Market se našlapuje kolem uživatelů, musí se být hrozně opatrně.

U uživatelů zkouší - co dělá, jak to dělá, apod. - snažíme se trefit do uživatelů
Uživatelský výzkum by chtěl trošku udělat jinak -> nedělají moc unguided testing.

Aktuální user reserach:
- 1-2 zástupci role
- všechny role naráz
	- cca. 10 lidí vs. 2 analytici (PO/Analytik)
	- občas na user reserach workshop sebou berou developera (why??? - proč je developer u user diskusí?)
	
Velká opatrnost - nechává se formálně schvalovat proces uživateli. Nefunguje moc vlastnictví procesů a rolí a odpovědností. Aktuálně jim chybí role "vlastník procesu" a manažer procesu - my je můžeme navrhovat, ale my je nemůžeme managovat/chybí vlastnictví exekuce.

Je vnímána extrémní rezistence vůči změnám - zejména vůči automatizaci, která by ohrozila někoho pohodlný píseček. Je tu hodně micro-managementu.


## Meeting 02.03.2026

##### Vnímaný velký rozdíl mezi waterfall vs. agile analýzou

#### Waterfall

Valná většina integrací je tvořena WATERFALLOVĚ (ŘÍDÍ PROJEKTOVÁ KANCELÁŘ)

1. Inciální setkání u kterých se dají dohromady high-level požadavky, které jsou schvalované
	- dělá se to v Clooney / IDEA
		- přebírá architektura, nebo @Tilsch Jan
	- dělá se to primárně pokud jsou předpokládány integrace
2. Schválení, než se začne analýza
3. Teprve pak začíná nějaká větší analýza
	- upřesnění projektů
	- vznikne WP (work package)
	- jsou nějaké představy o požadavcích atd.
	- vzniká **technický koncept**
		- zpřesněné požadavky od ana
		- pracuje na tom primárně architekt
4. Quick Scan
	- rozpad WP na jednotlivé systémy
	- sbírají se požadavky systémové - od různých systémů
5. Další schvalování
6. Detailní design / Analýza per systém (HLD)
	- detail je stále sledován v Clooney (v JIRA je akorát mirror pro)
7. Vývoj

##### Sběr požadavků
- giga meeting ke scope a tahají se informace
- vlastník požadavku
- účastníci procesu
- (pokud to není totálně new, tak se i mapuje existující proces)
- primárně to řeší:
	- Michal nebo Luboš, Tilsch Jan x Robo
	- případně architekt
- 

Radim Kolek a Silva Valientová -> mají nějakou metodiku prý, podle který se prý dělají věci.

Potřebujeme přidat kousek aplikace, přidat proces, něco -> analytik nebo produkťák dostane zadání.

"Business ví přesně co chce, nechce si to nechat měnit, je to uspěchaný, atd." - všichni chtějí všechno hned, nikdo nechce čekat, dokumentace neexistuje.

**Tomáš: Chybí nám 121 - nějaké rovnání procesů apod.**
- mrzí ho jako analytika, že nejsou akceptační testy z pohledu analýzy / product ownera
- note - chybí tady akceptační kritéria
- chybí testovací templates projektů ---
- chybí oprávnění v rámci prostředí
- basically, nemůže dělat AKCEPTAČNÍ kritéria


Note for next: jak vypadá IT analýza
- tím že chybí dokumentace, tak se tohle moc nedělá / nedá dělat

## Michal Vokr

- primárně se řeší integrační architektura (a integrační design)
- chybí mu:
	- větší detail v AS-IS stavu - vysvětlení
	- není nad tím přemýšleno, k čemu co je atd.
	- detaily atributů
- business analýza dodává pouze seznamy požadavků, neřeší logiku, zda požadavek dává smysl, zda je realizovatelný
- z jeho pohledu chybí detailní analýza - zejména určení dopadů do existujícího systému




