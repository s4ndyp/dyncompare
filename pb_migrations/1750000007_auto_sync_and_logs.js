/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const open = "";

    const settings = app.findCollectionByNameOrId("settings");
    const addBool = (name) => {
      try {
        settings.fields.getByName(name);
      } catch (_) {
        settings.fields.add(
          new BoolField({
            name,
            required: false,
          })
        );
      }
    };
    addBool("auto_sync_enabled");
    try {
      settings.fields.getByName("last_auto_sync_date");
    } catch (_) {
      settings.fields.add(
        new DateField({
          name: "last_auto_sync_date",
          required: false,
        })
      );
    }
    app.save(settings);

    const syncLogs = new Collection({
      type: "base",
      name: "sync_logs",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: ["CREATE INDEX idx_sync_logs_started ON sync_logs (started_at)"],
      fields: [
        {
          type: "date",
          name: "started_at",
          required: true,
        },
        {
          type: "date",
          name: "finished_at",
          required: false,
        },
        {
          type: "select",
          name: "status",
          required: true,
          maxSelect: 1,
          values: ["success", "error"],
        },
        {
          type: "select",
          name: "trigger",
          required: false,
          maxSelect: 1,
          values: ["manual", "auto"],
        },
        {
          type: "text",
          name: "message",
          required: false,
          max: 500,
        },
        {
          type: "bool",
          name: "sync_ha",
          required: false,
        },
        {
          type: "bool",
          name: "market_missing_only",
          required: false,
        },
        {
          type: "number",
          name: "days",
          required: false,
          min: 0,
        },
        {
          type: "number",
          name: "consumption_hours",
          required: false,
          min: 0,
        },
        {
          type: "number",
          name: "price_slots",
          required: false,
          min: 0,
        },
        {
          type: "text",
          name: "error_detail",
          required: false,
          max: 500,
        },
      ],
    });
    app.save(syncLogs);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("sync_logs"));
    } catch (_) {}
    const settings = app.findCollectionByNameOrId("settings");
    for (const name of ["auto_sync_enabled", "last_auto_sync_date"]) {
      try {
        settings.fields.removeByName(name);
      } catch (_) {}
    }
    app.save(settings);
  }
);
