# DynCompare

Vergelijk je **vaste stroomtarief** met wat je **zou hebben betaald op de day-ahead markt** (plus optionele opslag), op basis van je **P1-verbruik uit Home Assistant**.

Stack: **PocketBase 0.40.4** + donkere PWA + **sync-service** (Python/FastAPI) die Home Assistant en marktprijzen ophaalt.

## Functies

- Uurverbruik import (P1 tarief 1 + 2) via HA `recorder/statistics_during_period`
- NL day-ahead prijzen via [Energy-Charts](https://api.energy-charts.info/) (CC BY 4.0)
- Optioneel: prijssensor uit HA (statistiek `mean`, 5-min of uur)
- Periodes: maand / 6 maanden / jaar
- Instelbaar vast tarief (standaard **€0,28/kWh**), markt-opslag en BTW

## Snel starten

```bash
git clone https://github.com/s4ndyp/dyncompare.git
cd dyncompare
docker compose up -d --build
```

- App: http://localhost:8097  
- Sync API: http://localhost:8098  
- PocketBase admin: http://localhost:8097/_/

### Eerste keer

1. Open **Instellingen** → vul **Home Assistant URL** en **long-lived access token** in.  
2. Controleer de vier P1-sensor-entity_id’s (vooringevuld).  
3. Pas je **vaste €/kWh** aan (standaard 0,28).  
4. Tik **Synchroniseer met Home Assistant** op het tabblad Vergelijk. De app toont een **voortgangsbalk** tot de sync klaar is (kan enkele minuten duren bij ~1 jaar data). Kies **24 uur** om snel te testen (sync + vergelijking alleen laatste dag).

**Vaker syncen** mag: per uur/prijs-slot wordt de bestaande rij **bijgewerkt** (unique index op `period_start`), geen dubbele records.

## Dynamische prijzen (Nordpool / markt)

**Standaard hoef je geen Nordpool-sensor in te vullen.** Bij elke sync haalt DynCompare **NL day-ahead** prijzen op via [Energy-Charts](https://api.energy-charts.info/) — dat is maanden aan marktprijs (EUR/kWh), los van je HA-setup.

Optioneel veld **Nordpool / HA-prijs** in Instellingen:

1. **Leeg laten** — alleen Energy-Charts (aanbevolen voor vergelijking “vast vs spot”).
2. **Entity ID** (bv. `sensor.nordpool_kwh`) — sync probeert eerst **statistieken** (`recorder/statistics_during_period`); als die leeg zijn, valt hij terug op **state-historie** (werkt ook zonder lange-termijn statistieken, zolang `recorder` de sensor logt).
3. Controleer in HA: **Ontwikkelhulpmiddelen → Statistieken** of **Geschiedenis** of je sensor data heeft. Zonder history/statistieken blijft alleen Energy-Charts over.

In de app-tab **Data** zie je hoeveel prijs-slots **Markt** vs **Home Assistant** zijn.

### Energy-Charts geblokkeerd of 429?

Energy-Charts beperkt het aantal requests (**HTTP 429 Too Many Requests**). De sync gebruikt chunks van **7 dagen**, **geen** snelle retries bij 429, en schakelt daarna over op **ENTSO-E** voor de rest van de run.

Optioneel: `MARKET_PRICE_SOURCE=entsoe` op de sync-container om Energy-Charts helemaal over te slaan.

Gratis **ENTSO-E** fallback (officiële Europese day-ahead, maanden/jaren historie):

1. Gratis account: https://transparency.entsoe.eu/ → login → **My Account** → **API Key**
2. Zet in de **sync**-container: `ENTSOE_API_TOKEN=jouw-key` (Dockhand: environment bij service `sync`)
3. Opnieuw synchroniseren — statusmelding toont `(markt via entsoe)` als fallback actief was.

**Nordpool-statistieken in HA** geven alleen historie **vanaf het moment dat statistieken aan staan**; voor maanden terug heb je markt-API (Energy-Charts of ENTSO-E) nodig. Oude Nordpool-**states** in HA zijn meestal beperkt tot de recorder-retentie (vaak ~10 dagen), niet maanden.

## Home Assistant

DynCompare gebruikt de **standaard recorder** en leest **lange-termijn uurstatistieken** (`change` in kWh) voor:

- `sensor.p1_energy_consumption_tarif_1`
- `sensor.p1_energy_consumption_tarif_2`
- `sensor.p1_energy_production_tarif_1` (info/export)
- `sensor.p1_energy_production_tarif_2`

Zorg dat deze sensoren in het **Energiedashboard** staan en uurstatistieken hebben (meestal automatisch bij `state_class: total_increasing`).

Token aanmaken: profiel → **Beveiliging** → **Long-lived access tokens**.

## Sync-service

Handmatig:

```bash
curl -X POST http://localhost:8098/sync \
  -H 'Content-Type: application/json' \
  -d '{"days": 400, "include_market_prices": true}'
```

Environment:

| Variabele | Default |
|-----------|---------|
| `POCKETBASE_URL` | `http://app:8090` |
| `ENTSOE_API_TOKEN` | leeg — fallback marktprijzen via ENTSO-E (aanbevolen bij 429) |
| `MARKET_PRICE_SOURCE` | `auto` — `entsoe` of `energy-charts` |

## Productie (GHCR) en Dockhand

Voor **Dockhand** (stack plakken of Git zonder build): gebruik **`compose.dockhand.yaml`** in de repo-root. Die file heeft **geen** `build:` — alleen kant-en-klare images van GHCR.

1. Nieuwe stack → plak de inhoud van `compose.dockhand.yaml`, of koppel Git repo `s4ndyp/dyncompare` met compose-pad **`compose.dockhand.yaml`** (relatief pad, **geen** leading `/`).
2. Deploy. App: poort **8097**, sync: **8098**.
3. Pull mislukt (401 / manifest unknown)? Zet de GHCR-packages **public** onder GitHub → Packages, of voeg **ghcr.io** credentials toe in Dockhand.

Lokaal ontwikkelen blijft `docker compose up -d --build` met `docker-compose.yml` (bouwt uit bron).

## Berekening (kort)

Voor elk uur: **import kWh** = tarief 1 + tarief 2.  
Dynamische kosten = som over uren van (kWh × gewogen prijs in dat uur) + **markt-opslag**.  
Vaste kosten = som kWh × **ingestelde vaste prijs**.  
Gemiddelde dynamische €/kWh = totale dynamische kosten / kWh met prijsdata.

## Licenties

- App: zelf hosten / eigen repo  
- Marktprijzen: Energy-Charts / Bundesnetzagentur (CC BY 4.0 — vermelding in app)
