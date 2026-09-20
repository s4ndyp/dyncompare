/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    let hasField = false;
    try {
      settings.fields.getByName("sync_include_ha");
      hasField = true;
    } catch (_) {}
    if (!hasField) {
      settings.fields.add(
        new BoolField({
          name: "sync_include_ha",
          required: false,
        })
      );
    }
    app.save(settings);
  },
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    try {
      settings.fields.removeByName("sync_include_ha");
    } catch (_) {}
    app.save(settings);
  }
);
