"""Config- en optie-flow voor HomeWizard Dashboard."""
from __future__ import annotations

import re
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    IconSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    ObjectSelector,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
)

from .const import (
    CONF_ADMIN_ONLY,
    CONF_BATTERY_SIGN,
    CONF_FEEDIN,
    CONF_GRID_VIEW,
    CONF_ICON,
    CONF_NETTING,
    CONF_OVERRIDES,
    CONF_PRICE,
    CONF_SOLAR_COUNTER,
    CONF_THEME,
    CONF_TITLE,
    CONF_URL_PATH,
    CONF_YEAR_DAY,
    CONF_YEAR_MONTH,
    DEFAULTS,
    DOMAIN,
)

URL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
PRICE = NumberSelector(NumberSelectorConfig(min=0, max=5, step=0.001, mode=NumberSelectorMode.BOX,
                                            unit_of_measurement="€/kWh"))


def _panel_schema(d: dict[str, Any]) -> dict:
    return {
        vol.Required(CONF_TITLE, default=d[CONF_TITLE]): TextSelector(),
        vol.Required(CONF_ICON, default=d[CONF_ICON]): IconSelector(),
        vol.Required(CONF_URL_PATH, default=d[CONF_URL_PATH]): TextSelector(),
        vol.Required(CONF_ADMIN_ONLY, default=d[CONF_ADMIN_ONLY]): BooleanSelector(),
        vol.Required(CONF_THEME, default=d[CONF_THEME]): SelectSelector(
            SelectSelectorConfig(options=["light", "dark", "auto"], translation_key="thema",
                                 mode=SelectSelectorMode.DROPDOWN)),
    }


def _data_schema(d: dict[str, Any]) -> dict:
    return {
        vol.Required(CONF_PRICE, default=d[CONF_PRICE]): PRICE,
        vol.Required(CONF_NETTING, default=d[CONF_NETTING]): BooleanSelector(),
        vol.Required(CONF_FEEDIN, default=d[CONF_FEEDIN]): PRICE,
        vol.Required(CONF_GRID_VIEW, default=d[CONF_GRID_VIEW]): SelectSelector(
            SelectSelectorConfig(options=["auto", "netto", "apart"], translation_key="stroom_totaal",
                                 mode=SelectSelectorMode.DROPDOWN)),
        vol.Required(CONF_YEAR_DAY, default=d[CONF_YEAR_DAY]): NumberSelector(
            NumberSelectorConfig(min=1, max=31, step=1, mode=NumberSelectorMode.BOX)),
        vol.Required(CONF_YEAR_MONTH, default=d[CONF_YEAR_MONTH]): NumberSelector(
            NumberSelectorConfig(min=1, max=12, step=1, mode=NumberSelectorMode.BOX)),
        vol.Required(CONF_SOLAR_COUNTER, default=d[CONF_SOLAR_COUNTER]): SelectSelector(
            SelectSelectorConfig(options=["auto", "import", "export"], translation_key="solar_counter",
                                 mode=SelectSelectorMode.DROPDOWN)),
        vol.Required(CONF_BATTERY_SIGN, default=d[CONF_BATTERY_SIGN]): SelectSelector(
            SelectSelectorConfig(options=["1", "-1"], translation_key="battery_power_sign",
                                 mode=SelectSelectorMode.DROPDOWN)),
        vol.Optional(CONF_OVERRIDES, default=d[CONF_OVERRIDES]): ObjectSelector(),
    }


def _validate(user_input: dict[str, Any]) -> dict[str, str]:
    errors: dict[str, str] = {}
    if CONF_URL_PATH in user_input:
        user_input[CONF_URL_PATH] = user_input[CONF_URL_PATH].strip().strip("/").lower()
        if not URL_RE.match(user_input[CONF_URL_PATH]):
            errors[CONF_URL_PATH] = "invalid_url_path"
    if CONF_OVERRIDES in user_input and not isinstance(user_input[CONF_OVERRIDES] or {}, dict):
        errors[CONF_OVERRIDES] = "invalid_overrides"
    return errors


class HwdashConfigFlow(ConfigFlow, domain=DOMAIN):
    """Eenmalige installatie: alleen de zijbalk-instellingen."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(title=user_input[CONF_TITLE], data={},
                                               options={**DEFAULTS, **user_input})
        d = {**DEFAULTS, **(user_input or {})}
        return self.async_show_form(step_id="user", data_schema=vol.Schema(_panel_schema(d)), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return HwdashOptionsFlow()


class HwdashOptionsFlow(OptionsFlow):
    """Alle opties wijzigen na installatie."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        current = {**DEFAULTS, **self.config_entry.options}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                user_input.setdefault(CONF_OVERRIDES, {})
                if user_input[CONF_TITLE] != self.config_entry.title:
                    self.hass.config_entries.async_update_entry(self.config_entry, title=user_input[CONF_TITLE])
                return self.async_create_entry(data={**current, **user_input})
        d = {**current, **(user_input or {})}
        return self.async_show_form(step_id="init",
                                    data_schema=vol.Schema({**_panel_schema(d), **_data_schema(d)}),
                                    errors=errors)
