/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId("consumption_hours");
    for (const name of [
      "import_t1_kwh",
      "import_t2_kwh",
      "export_t1_kwh",
      "export_t2_kwh",
    ]) {
      const field = collection.fields.getByName(name);
      if (!field) continue;
      field.required = false;
      field.min = 0;
    }
    app.save(collection);
  },
  (app) => {
    const collection = app.findCollectionByNameOrId("consumption_hours");
    for (const name of [
      "import_t1_kwh",
      "import_t2_kwh",
      "export_t1_kwh",
      "export_t2_kwh",
    ]) {
      const field = collection.fields.getByName(name);
      if (!field) continue;
      field.required = true;
      field.min = null;
    }
    app.save(collection);
  }
);
