# Electricity Monitor

Watches your smart breaker (Gaqqee KWS-302WF, added to Home Assistant with Tuya Local) and keeps
its own history: every power cut, every time the breaker switches itself off and why, how much
electricity you use, what it costs on the Palli Bidyut prepaid tariff, and how much balance is left.

## How it decides what happened

| What you see | How it's recognised |
|---|---|
| **Power cut** (load shedding) | The breaker stops answering for longer than *Power cut after* (90 s), while Home Assistant keeps running on the IPS. When it comes back its energy counter hasn't moved. |
| **Wi-Fi drop** | It stopped answering, but its energy counter kept counting, so it had power. The router's daily 04:01 reboot shows up as a short drop and isn't counted as a cut. If a "power cut" alert already went out, a "false alarm" follows. |
| **Breaker tripped** | The relay switched off while the breaker still had power. The reason comes from the readings in the minute around it: voltage at the over/low-voltage limit, current, power, temperature or energy at their limits. If someone switched it in Home Assistant, the Activity log says who. Anything else was done in the Smart Life app or at the breaker. |
| **Stayed off after the power returned** | The power came back but the relay is off (what happened on 27 Oct). Alexa says so and keeps reminding you every 10 minutes until it's on. With *Turn it back on automatically*, the add-on does it once the voltage has been steady. |
| **Fault code** | The breaker's Problem sensor stays *unavailable* until the breaker sends a fault code, which this model hasn't done so far. If it ever does, that code replaces the guess. |

**Restarts.** Every change is also in Home Assistant's recorder. After this add-on or Home Assistant
restarts, the add-on replays the recorder from where it stopped, so nothing in between is lost.
For the time Home Assistant itself was down nobody saw the breaker; the add-on compares its energy
counter before and after: if energy is missing, it records an estimated power cut, otherwise a
"monitor offline" gap. A power cut that was in progress carries on across the restart.

The first start imports Home Assistant's long-term statistics (hourly energy and readings since
the breaker was added) and the last 10 days of detail, so the history isn't empty.

## The dashboard

- **Live**: power on / power cut / breaker tripped, with a running timer; power, voltage against the
  cut-offs, current, power factor, frequency, breaker temperature; today and this month, the price
  slab, the prepaid balance; a 24-hour strip; the load-shedding forecast; recent events. A tripped
  breaker can be switched back on from here.
- **Power cuts**: counts, total time without power, longest and average cut for today, 7, 30, 90 days
  or the year; when cuts usually happen (weekday × hour); the chance of a cut in each hour; a
  year calendar; every cut, with whether the internet (Net Monitor) went down too; "what was the
  power like at…"; CSV export.
- **Protection**: the breaker's limits (over/low voltage, over-current, over-power, temperature,
  energy), editable, with how close the readings are to each; advice from 30 days of readings; every
  switch-off with its reason, the readings and who turned it back on. Turn on/off, clear the trip flag.
- **Usage & bill**: kWh by hour, day or month with cost and comparisons; this month's bill line by line
  (slabs, demand charge, meter rent, VAT, rebate) and the month-end projection, including the day
  you'd cross into a pricier slab; the slab ladder; when you use the most; month by month.
- **Prepaid**: the estimated balance on the meter, days left and the run-out day. Enter what the
  meter shows now and then (it's counted down from your usage in between) and add each recharge.
  The month's first recharge pays the demand charge and meter rent first, as on the real meter.
- **Power quality**: a voltage grade, time in the good/fair/bad bands, highest and lowest voltage,
  charts of voltage (with cut-offs), power, frequency, power factor and breaker temperature, and
  every high or low voltage spell.
- **Appliances**: the always-on load and what it costs a month; big loads spotted as steps in the
  total power (AC, pump, iron…) with runs, running time, energy and cost. Name them.
- **Alerts**: where each alert goes, test buttons, report previews and the alert history.

## Alerts

| Alert | Default |
|---|---|
| Power cut / power back | Alexa, phone; power back with a report on WhatsApp |
| Breaker tripped (with the reason) | Alexa, phone, WhatsApp; repeated until it's back on |
| Stayed off after the power returned | Alexa, phone, WhatsApp; repeated |
| Breaker back on | Alexa, phone |
| Voltage near a cut-off, breaker getting hot | Alexa (voltage), phone |
| Low prepaid balance, price slab warnings | Phone, WhatsApp (balance also on Alexa) |

Trips are announced even in quiet hours (switchable). During a power cut the Echo may be unpowered;
then the phone set in *Phone speaks if no Echo answers* reads the alert aloud. WhatsApp goes through
the PDC WhatsApp Bridge and uses its own recipient and token unless you set others. A weekly and
a monthly report arrive on WhatsApp (daily is optional).

## Sensors it adds to Home Assistant

`binary_sensor.electricity_grid_power`, `sensor.electricity_status`, `sensor.electricity_last_power_cut`,
`sensor.electricity_power_cuts_today`, `sensor.electricity_power_cut_minutes_today`,
`sensor.electricity_last_breaker_off`, `sensor.electricity_energy_today`, `sensor.electricity_energy_month`,
`sensor.electricity_bill_month`, `sensor.electricity_price_slab`, `sensor.electricity_prepaid_balance`,
`sensor.electricity_next_likely_power_cut`.

## Tariff

Defaults are BERC's residential (LT-A) rates from June 2026, which every distributor including Palli
Bidyut uses: lifeline ৳4.63 (up to 50 units), then ৳5.26 / 8.50 / 9.10 / 9.62 / 15.01 / 17.35 per unit
for 1-75 / 76-200 / 201-300 / 301-400 / 401-600 / 601+, demand charge ৳42 per sanctioned kW, meter rent
৳40, 5% VAT, 0.5% prepaid rebate. Set your **sanctioned load** (on the meter card) in Settings, and
change the rates there when BERC changes them. If the prepaid meter counts a little more or less than
the breaker, set *Energy correction*.

## Options

Everything is editable in the dashboard's Settings (it saves to the add-on's Configuration tab).
`breaker_prefix` is the breaker's entity name without the domain (`energy_meter` for
`switch.energy_meter`).
