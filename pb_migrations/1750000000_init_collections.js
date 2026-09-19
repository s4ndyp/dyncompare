/// <reference path="../pb_data/types.d.ts" />

migrate(
  (app) => {
    const open = "";

    const settings = new Collection({
      type: "base",
      name: "settings",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      fields: [
        {
          type: "text",
          name: "label",
          required: true,
          max: 80,
        },
        {
          type: "number",
          name: "fixed_tariff_eur_kwh",
          required: true,
          min: 0,
        },
        {
          type: "number",
          name: "market_markup_eur_kwh",
          min: 0,
        },
        {
          type: "number",
          name: "vat_rate",
          min: 0,
          max: 1,
        },
        {
          type: "url",
          name: "ha_url",
          required: false,
        },
        {
          type: "text",
          name: "ha_token",
          required: false,
          max: 500,
        },
        {
          type: "url",
          name: "sync_service_url",
          required: false,
        },
        {
          type: "text",
          name: "sensor_import_t1",
          required: false,
          max: 120,
        },
        {
          type: "text",
          name: "sensor_import_t2",
          required: false,
          max: 120,
        },
        {
          type: "text",
          name: "sensor_export_t1",
          required: false,
          max: 120,
        },
        {
          type: "text",
          name: "sensor_export_t2",
          required: false,
          max: 120,
        },
        {
          type: "text",
          name: "price_statistic_id",
          required: false,
          max: 120,
        },
        {
          type: "date",
          name: "last_sync_at",
          required: false,
        },
        {
          type: "text",
          name: "last_sync_message",
          required: false,
          max: 500,
        },
      ],
    });

    app.save(settings);

    const consumptionHours = new Collection({
      type: "base",
      name: "consumption_hours",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: [
        "CREATE UNIQUE INDEX idx_consumption_hours_period ON consumption_hours (period_start)",
      ],
      fields: [
        {
          type: "date",
          name: "period_start",
          required: true,
        },
        {
          type: "number",
          name: "import_t1_kwh",
          required: false,
          min: 0,
        },
        {
          type: "number",
          name: "import_t2_kwh",
          required: false,
          min: 0,
        },
        {
          type: "number",
          name: "export_t1_kwh",
          required: false,
          min: 0,
        },
        {
          type: "number",
          name: "export_t2_kwh",
          required: false,
          min: 0,
        },
      ],
    });

    app.save(consumptionHours);

    const priceSlots = new Collection({
      type: "base",
      name: "price_slots",
      listRule: open,
      viewRule: open,
      createRule: open,
      updateRule: open,
      deleteRule: open,
      indexes: [
        "CREATE UNIQUE INDEX idx_price_slots_period ON price_slots (period_start)",
        "CREATE INDEX idx_price_slots_source ON price_slots (source)",
      ],
      fields: [
        {
          type: "date",
          name: "period_start",
          required: true,
        },
        {
          type: "number",
          name: "price_eur_kwh",
          required: true,
        },
        {
          type: "select",
          name: "source",
          required: true,
          maxSelect: 1,
          values: ["market", "home_assistant", "manual"],
        },
        {
          type: "number",
          name: "interval_minutes",
          required: true,
          min: 1,
        },
      ],
    });

    app.save(priceSlots);
  },
  (app) => {
    for (const name of ["price_slots", "consumption_hours", "settings"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (e) {
        /* ignore */
      }
    }
  }
);
