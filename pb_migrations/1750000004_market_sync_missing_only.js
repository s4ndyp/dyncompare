/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    let field = null;
    try {
      field = settings.fields.getByName("market_sync_missing_only");
    } catch (_) {
      /* field ontbreekt */
    }
    if (!field) {
      settings.fields.add(
        new BoolField({
          name: "market_sync_missing_only",
          required: false,
        })
      );
    }
    app.save(settings);
  },
  (app) => {
    const settings = app.findCollectionByNameOrId("settings");
    const field = settings.fields.getByName("market_sync_missing_only");
    if (field) {
      settings.fields.removeByName("market_sync_missing_only");
    }
    app.save(settings);
  }
);
