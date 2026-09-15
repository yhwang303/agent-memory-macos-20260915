/**
 * Plugin framework shared types.
 *
 * These types define the contract between the plugin system and each plugin's
 * UI contribution. The core viewer/settings pages use PluginUIManifest to
 * dynamically render plugin tabs and panels — no hardcoding required.
 */

/**
 * Describes a plugin's tab in the viewer page.
 */
export interface PluginUITab {
  /** Tab button label */
  label: string;
  /** Optional icon (emoji or short text) */
  icon?: string;
  /** Display order (lower = earlier, core tabs are 0-50) */
  order: number;
  /** DOM id for badge element (optional) */
  badge?: string;
  /** Optional extra CSS class for styling the tab button */
  cssClass?: string;
}

/**
 * Settings card descriptor for desktop settings page.
 */
export interface PluginUISettingsCard {
  /** Card title */
  title: string;
  /** Subtitle / short description */
  subtitle?: string;
  /** Display order */
  order: number;
  /** Accent color (CSS color value) */
  accentColor?: string;
}

/**
 * The full UI manifest that each plugin contributes.
 * Returned by GET /api/plugins/ui-manifest.
 * Consumed by both the web viewer and the desktop settings page.
 */
export interface PluginUIManifest {
  /** Unique plugin ID, e.g. "self-evolve", "shadwmonitor" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether the plugin is currently enabled */
  enabled: boolean;
  /** Viewer page tab definition (omit if plugin has no viewer tab) */
  tab?: PluginUITab;
  /** Settings page card definition (omit if plugin has no settings card) */
  settingsCard?: PluginUISettingsCard;
}
