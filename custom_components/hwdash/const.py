"""Constanten voor de HomeWizard Dashboard-integratie."""

DOMAIN = "hwdash"
STATIC_URL = "/hwdash_static"
WEBCOMPONENT = "hwdash-panel"

CONF_TITLE = "sidebar_title"
CONF_ICON = "sidebar_icon"
CONF_URL_PATH = "url_path"
CONF_ADMIN_ONLY = "require_admin"
CONF_PRICE = "prijs_kwh"
CONF_NETTING = "saldering"
CONF_FEEDIN = "teruglever_prijs"
CONF_SOLAR_COUNTER = "solar_counter"
CONF_BATTERY_SIGN = "battery_power_sign"
CONF_GRID_VIEW = "stroom_totaal"
CONF_YEAR_DAY = "jaar_start_dag"
CONF_YEAR_MONTH = "jaar_start_maand"
CONF_THEME = "thema"
CONF_OVERRIDES = "overrides"

DEFAULTS = {
    CONF_TITLE: "HomeWizard",
    CONF_ICON: "mdi:home-lightning-bolt",
    CONF_URL_PATH: "homewizard",
    CONF_ADMIN_ONLY: False,
    CONF_PRICE: 0.40,
    CONF_NETTING: True,
    CONF_FEEDIN: 0.0,
    CONF_SOLAR_COUNTER: "auto",
    CONF_BATTERY_SIGN: "1",
    CONF_GRID_VIEW: "auto",
    CONF_YEAR_DAY: 1,
    CONF_YEAR_MONTH: 1,
    CONF_THEME: "light",
    CONF_OVERRIDES: {},
}
