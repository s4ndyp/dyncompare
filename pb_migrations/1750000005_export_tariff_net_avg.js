/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");

    if (!settings.fields.getByName("export_tariff_eur_kwh")) {
      settings.fields.add(
        new NumberField({
          name: "export_tariff_eur_kwh",
          required: false,
          min: 0,
        })
      );
    }

    if (!settings.fields.getByName("include_export_in_avg")) {
      settings.fields.add(
        new BoolField({
          name: "include_export_in_avg",
          required: false,
        })
      );
    }

    app.save(settings);
  },
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    for (const name of ["export_tariff_eur_kwh", "include_export_in_avg"]) {
      try {
        settings.fields.removeByName(name);
      } catch (_) {
        /* field ontbreekt */
      }
    }
    app.save(settings);
  }
);
