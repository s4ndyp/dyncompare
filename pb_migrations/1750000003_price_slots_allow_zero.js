/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId("price_slots");
    const field = collection.fields.getByName("price_eur_kwh");
    if (field) {
      field.required = false;
    }
    app.save(collection);
  },
  (app) => {
    const collection = app.findCollectionByNameOrId("price_slots");
    const field = collection.fields.getByName("price_eur_kwh");
    if (field) {
      field.required = true;
    }
    app.save(collection);
  }
);
