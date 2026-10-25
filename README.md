# HomeWizard Dashboard voor Home Assistant

Een zijbalk-panel voor Home Assistant dat eruitziet en werkt als de HomeWizard Energy-app.
De data komt uit de HomeWizard-integratie die je al in HA hebt draaien.

- **Indeling als de app:** een kop met opwek, zelfvoorzienend, net, kosten en teruglevering,
  daaronder kaarten met grafieken voor stroomverbruik, stroom totaal, zelfvoorzienend,
  zonnepanelen, batterij (laden, ontladen en laadniveau), elke warmtepomp, de watermeter en
  Overvoltage (spanning per fase met de grens van 253 V).
- **Levend huis in de kop:** dag- of nachthemel (volgt `sun.sun`) en live stroomlijnen vanuit
  de P1-meter: afname van het net (paars), teruglevering (groen), zonnepanelen (groen),
  batterij laden en ontladen (beide groen), de warmtepomp (paars, pas boven 20 W zodat
  stand-by niet meetelt) en stromend water (blauw) zodra de watermeter doorstroming meet. De batterijstapel toont het aantal gevonden batterijen (max. 4).
- **Week, Maand en Jaar** als gegroepeerde staafgrafieken zoals de app (afname, teruglevering,
  zelfvoorzienend, laden en ontladen naast elkaar); Maand toont staven per weeknummer.
- **Detailscherm per grafiek:** tik op het icoon van een kaart. Schermvullend met legenda, de
  geselecteerde staaf met alle waarden en de waarde boven elke staaf; kantel je telefoon voor een
  liggende weergave. De terug-pijl (of de terugknop) brengt je terug.
- **Licht en donker thema:** het donkere thema heeft geen tegels en laat de grafieken in elkaar
  overlopen. Staven zijn afgerond gunmetal, belicht door een lamp in de eigen kleur, met een
  subtiele reflectie op de vloer; lijnen hebben een heldere kern met een rustige gloed. Wisselen kan met de
  zon/maan-knop rechtsboven of via de optie *Thema*.
- **Zwevende periodekiezer:** Nu, Dag, Week, Maand en Jaar met datumnavigatie; geldt voor alle
  kaarten tegelijk. Aanraakcursor met waarden per grafiek. Hetzelfde kleurgebruik als de app
  (paars = afname/laden, groen = opwek/teruglevering/ontladen, blauw = zelfvoorzienend/water).
- **Zelfvoorzienend** telt zoals de app: opwek min teruglevering (dus ook wat de batterij in
  gaat). Stroomverbruik is afname van het net plus zelfvoorzienend.
- **Stroom totaal** toont bij saldering de netto afname (afname min teruglevering) met de netto
  kosten, net als de app. Zonder saldering (standaard vanaf 2027) staan afname met kosten en
  teruglevering met vergoeding apart.
- **Kosten van het stroomverbruik** worden per uur berekend: verbruik (net + zelfvoorzienend)
  × de uurprijs. De uurprijs komt uit de prijs-entiteit van het Energie-dashboard (bijv. een dynamisch uurtarief),
  of anders uit kosten ÷ afname van dat uur.
- **Kosten** komen uit de kostenstatistieken van het HA Energie-dashboard (bijvoorbeeld
  een dynamisch contract). Zonder die statistieken wordt een vaste prijs gebruikt.
- **Automatische detectie** van de P1-meter, watermeter, plug-in batterijen en kWh-meters.
  Zon en warmtepomp worden herkend aan de apparaatnaam. Van de P1-meter worden ook de
  spanning per fase en het batterijgroep-vermogen (`battery_group_power`) gebruikt, als die
  entiteiten ingeschakeld zijn. Het batterijgroep-vermogen heeft voorrang op de som van de
  losse batterijen.
- Werkt in de browser en in de HA Companion-app, en gebruikt je ingelogde sessie.
  Je hebt dus geen tokens of losse servers nodig.

## Vereisten

- Home Assistant **2024.6** of nieuwer.
- [HACS](https://hacs.xyz/docs/use/) is geïnstalleerd (alleen nodig voor installatie via HACS).
- De officiële **HomeWizard**-integratie is in Home Assistant ingesteld, met je HomeWizard-apparaten
  (P1-meter, kWh-meters, watermeter, plug-in batterijen). Het dashboard gebruikt de gegevens van
  die integratie en heeft zelf geen verbinding met de apparaten.
- Optioneel: het **Energie-dashboard** van Home Assistant met prijzen of kosten. Dan toont het
  dashboard je echte kosten; zonder Energie-dashboard wordt een vaste prijs gebruikt.

## Installatie via HACS (aanbevolen)

Dit dashboard staat niet in de standaardlijst van HACS. Je voegt het daarom eenmalig toe
als *custom repository*.

[![Openen in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=rvdlinden&repository=HomeWizard-Dashboard&category=integration)

Met de knop hierboven kun je stap 1 t/m 3 overslaan. Liever met de hand:

1. Open in Home Assistant **HACS** in de zijbalk.
2. Kies rechtsboven **⋮ → Custom repositories**.
3. Vul in:
   - **Repository:** `https://github.com/rvdlinden/HomeWizard-Dashboard`
   - **Type:** `Integration`

   en kies **Add**. Sluit daarna het venster.
4. Zoek in HACS op **HomeWizard Dashboard**, open het en kies rechtsonder **Download**.
   Bevestig met **Download**.
5. Herstart Home Assistant: **Instellingen → Systeem → ⏻ (rechtsboven) → Home Assistant herstarten**.
6. Ga naar **Instellingen → Apparaten & diensten → + Integratie toevoegen**, zoek op
   **HomeWizard Dashboard** en volg de stappen. Je kunt hier de naam, het icoon en het URL-pad
   van het panel kiezen, of de standaardwaarden laten staan.
7. In de zijbalk staat nu **HomeWizard**. Ververs de pagina (of herstart de Companion-app) als
   je het nog niet ziet.

De HomeWizard-apparaten worden automatisch gevonden. Onder het tandwiel rechtsboven in het
dashboard zie je wat er gedetecteerd is. Prijzen en overige instellingen pas je aan via
**Instellingen → Apparaten & diensten → HomeWizard Dashboard → Configureren** (zie *Opties*).

### Bijwerken

HACS meldt een nieuwe versie vanzelf onder **Instellingen → Updates** en in HACS zelf. Kies
**Update**, herstart Home Assistant en ververs de pagina in je browser of de Companion-app.

### Verwijderen

1. **Instellingen → Apparaten & diensten → HomeWizard Dashboard → ⋮ → Verwijderen.**
2. In HACS: open **HomeWizard Dashboard → ⋮ → Verwijderen**.
3. Herstart Home Assistant.

## Handmatige installatie (zonder HACS)

1. Download de nieuwste release van
   [github.com/rvdlinden/HomeWizard-Dashboard/releases](https://github.com/rvdlinden/HomeWizard-Dashboard/releases)
   (*Source code (zip)*) en pak hem uit.
2. Kopieer de map `custom_components/hwdash` naar `/config/custom_components/hwdash` op je Home
   Assistant (bijv. met de Samba- of File editor-add-on).
3. Herstart Home Assistant en voeg de integratie toe zoals in stap 6 hierboven.

Bij een handmatige installatie werk je bij door de map `hwdash` te vervangen door die uit een
nieuwe release en Home Assistant te herstarten.

## Opties

Via **HomeWizard Dashboard → Configureren** stel je het volgende in:

| Optie | Uitleg |
|---|---|
| Naam, icoon, URL-pad | Hoe en waar het panel in de zijbalk staat (standaard `/homewizard`) |
| Alleen beheerders | Verbergt het panel voor gewone gebruikers |
| Thema | `Licht`, `Donker` of `Volg Home Assistant`. De zon/maan-knop rechtsboven in het panel overschrijft dit per apparaat |
| Vaste stroomprijs | Wordt alleen gebruikt als het Energie-dashboard geen kostenstatistiek heeft |
| Saldering / terugleverprijs | Hoe teruglevering verrekend wordt bij een vaste prijs |
| Weergave Stroom totaal | `Automatisch` (netto t/m 2026, afname en teruglevering apart vanaf 1 jan 2027), `Altijd netto` of `Apart` |
| Startdag en -maand jaaroverzicht | Laat het jaar beginnen op je afrekendatum (titel 2026/2027). Het jaaroverzicht toont gewone kalendermaanden; alleen de afrekenmaand is gedeeld. Bijv. start 15 april: 15–30 april, mei t/m maart, 1–14 april |
| Opwekteller | Welke teller van de zon-kWh-meter de opwek is: `auto`, `import` of `export` |
| Teken batterijvermogen | Zet dit om als laden en ontladen in het panel verwisseld zijn |
| Overrides | Koppel sensoren handmatig als de detectie iets mist |

Een voorbeeld voor overrides:

```yaml
solar:
  - name: Zonnepanelen
    energy: sensor.zonnepanelen_energie_export
    power: sensor.zonnepanelen_vermogen
grid:
  voltage: [sensor.p1_spanning_fase_1, sensor.p1_spanning_fase_2, sensor.p1_spanning_fase_3]
  battery_power: sensor.p1_battery_group_power
wp:
  - {name: Binnenunit, kind: binnen, energy: sensor.wp_binnen_energie_import, power: sensor.wp_binnen_vermogen}
  - {name: Buitenunit, kind: buiten, energy: sensor.wp_buiten_energie_import, power: sensor.wp_buiten_vermogen}
```

Onder het tandwiel in het panel zie je welke sensoren er gedetecteerd zijn.

## Hoe het werkt

De integratie serveert de frontend vanaf `/hwdash_static/` en registreert een custom panel.
De URL van het panel bevat een hash van het JS-bestand, zodat browsers na een update vanzelf
de nieuwe versie laden. Het panel haalt zijn data via de websocket-API op uit de entity- en
device-registry, `recorder/statistics_during_period` en `energy/get_prefs`. De
Dag-weergave gebruikt de 5-minutenstatistiek. Is die al opgeschoond, standaard na 10 dagen,
dan valt de weergave terug op uurwaarden.

## Ontwikkeling

```
custom_components/hwdash/
  __init__.py, config_flow.py, const.py   registratie van het panel en de opties
  frontend/hwdash-panel.js                het panel: datalaag (HwData) en weergave
  frontend/chart.umd.min.js               Chart.js
```

Het panel is één JavaScript-module zonder build-stap: pas `hwdash-panel.js` aan en herlaad
de integratie. Verhoog bij een release `version` in `manifest.json` en `HWDASH_VERSION` in
`hwdash-panel.js`, en maak een GitHub-release met tag `X.Y.Z`, zodat HACS de update meldt.
