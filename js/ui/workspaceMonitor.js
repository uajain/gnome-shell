// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;
const Shell = imports.gi.Shell;

const Main = imports.ui.main;
const ViewSelector = imports.ui.viewSelector;

var WorkspaceMonitor = new Lang.Class({
    Name: 'WorkspaceMonitor',

    _init: function() {
        this._shellwm = global.window_manager;
        this._shellwm.connect('minimize', this._windowDisappearing.bind(this));
        this._shellwm.connect('minimize-completed', this._windowDisappeared.bind(this));
        this._shellwm.connect('destroy', this._windowDisappearing.bind(this));
        this._shellwm.connect('destroy-completed', this._windowDisappeared.bind(this));

        this._windowTracker = Shell.WindowTracker.get_default();
        this._windowTracker.connect('tracked-windows-changed', this._trackedWindowsChanged.bind(this));

        this._metaScreen = global.screen;
        this._metaScreen.connect('in-fullscreen-changed', this._fullscreenChanged.bind(this));

        let primaryMonitor = Main.layoutManager.primaryMonitor;
        this._inFullscreen = primaryMonitor && primaryMonitor.inFullscreen;

        this._appSystem = Shell.AppSystem.get_default();
    },

    _fullscreenChanged: function() {
        let primaryMonitor = Main.layoutManager.primaryMonitor;
        let inFullscreen = primaryMonitor && primaryMonitor.inFullscreen;

        if (this._inFullscreen != inFullscreen) {
            this._inFullscreen = inFullscreen;
            this._updateOverview();
        }
    },

    _windowDisappearing: function(shellwm, actor) {
        function _isLastWindow(apps, win) {
            if (apps.length == 0)
                return true;

            if (apps.length > 1)
                return false;

            let windows = apps[0].get_windows();
            return (windows.length == 1) && (windows[0] == win);
        };

        let visibleApps = this._getVisibleApps();
        if (_isLastWindow(visibleApps, actor.meta_window))
            Main.layoutManager.prepareToEnterOverview();
    },

    _updateOverview: function() {
        let visibleApps = this._getVisibleApps();
        if (visibleApps.length == 0) {
            // Even if no apps are visible, if there is an app starting up, we
            // do not show the overview as it's likely that a window will be
            // shown. This avoids problems of windows being mapped while the
            // overview is being shown.
            if (!this._appSystem.has_starting_apps())
                Main.overview.showApps();
        } else if (this._inFullscreen) {
            // Hide in fullscreen mode
            Main.overview.hide();
        }
    },

    _windowDisappeared: function(shellwm, actor) {
        this._updateOverview();
    },

    _trackedWindowsChanged: function() {
        let visibleApps = this._getVisibleApps();
        let isShowingAppsGrid = Main.overview.visible &&
            Main.overview.getActivePage() === ViewSelector.ViewPage.APPS;

        if (visibleApps.length > 0 && isShowingAppsGrid) {
            // Make sure to hide the apps grid so that running apps whose
            // windows are becoming visible are shown to the user.
            Main.overview.hide();
        } else {
            // Fallback to the default logic used for dissapearing windows.
            this._updateOverview();
        }
    },

    _getVisibleApps: function() {
        let runningApps = this._appSystem.get_running();
        return runningApps.filter(function(app) {
            let windows = app.get_windows();
            for (let window of windows) {
                // We do not count transient windows because of an issue with Audacity
                // where a transient window was always being counted as visible even
                // though it was minimized
                if (window.get_transient_for())
                    continue;

                if (!window.minimized)
                    return true;
            }

            return false;
        });
    },

    get hasActiveWindows() {
        // Count anything fullscreen as an extra window
        if (this._inFullscreen)
            return true;

        let apps = this._appSystem.get_running();
        return apps.length > 0;
    },

    get hasVisibleWindows() {
        // Count anything fullscreen as an extra window
        if (this._inFullscreen)
            return true;

        let visibleApps = this._getVisibleApps();
        return visibleApps.length > 0;
    }
});
