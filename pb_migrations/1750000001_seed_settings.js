/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    const existing = app.findRecordsByFilter(settings, 'id != ""');
    if (existing.length > 0) return;

    const record = new Record(settings);
    record.set("label", "Standaard");
    record.set("fixed_tariff_eur_kwh", 0.28);
    record.set("market_markup_eur_kwh", 0);
    record.set("vat_rate", 0);
    record.set("sensor_import_t1", "sensor.p1_energy_consumption_tarif_1");
    record.set("sensor_import_t2", "sensor.p1_energy_consumption_tarif_2");
    record.set("sensor_export_t1", "sensor.p1_energy_production_tarif_1");
    record.set("sensor_export_t2", "sensor.p1_energy_production_tarif_2");
    app.save(record);
  },
  () => {}
);
