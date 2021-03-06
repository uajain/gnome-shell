// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Shell = imports.gi.Shell;

const AppActivation = imports.ui.appActivation;
const BoxPointer = imports.ui.boxpointer;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

var BackgroundMenu = new Lang.Class({
    Name: 'BackgroundMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(layoutManager) {
        this.parent(layoutManager.dummyCursor, 0, St.Side.TOP);

        this.addSettingsAction(_("Change Background…"), 'gnome-background-panel.desktop');
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.addAction(_("Add App"), () => {
            let app = Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop');
            let activationContext = new AppActivation.AppActivationContext(app);
            activationContext.activate(Clutter.get_current_event());
        });

        this.addAction(_("Add Website"), () => {
            Main.appStore.showPage(global.get_current_time(), 'web');
        });

        this.addAction(_("Add Folder"), () => {
            IconGridLayout.layout.addFolder();
        });

        this.actor.add_style_class_name('background-menu');

        layoutManager.uiGroup.add_actor(this.actor);
        this.actor.hide();
    }
});

function _addBackgroundMenuFull(actor, clickAction, layoutManager) {
    // We don't want the background menu enabled on the desktop
    // during the FBE, or in any mode without an overview, fwiw.
    if (!Main.sessionMode.hasOverview)
        return;

    // Either the actor or the action has to be defined
    if (!actor && !clickAction)
        return;

    if (actor) {
        clickAction = new Clutter.ClickAction();
        actor.add_action(clickAction);
    } else {
        actor = clickAction.get_actor();
    }

    actor.reactive = true;
    actor._backgroundMenu = new BackgroundMenu(layoutManager);
    actor._backgroundManager = new PopupMenu.PopupMenuManager({ actor: actor });
    actor._backgroundManager.addMenu(actor._backgroundMenu);

    function openMenu(x, y) {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        actor._backgroundMenu.open(BoxPointer.PopupAnimation.NONE);
    }

    clickAction.connect('long-press', function(action, actor, state) {
        if (state == Clutter.LongPressState.QUERY)
            return ((action.get_button() == 0 ||
                     action.get_button() == 1) &&
                    !actor._backgroundMenu.isOpen);
        if (state == Clutter.LongPressState.ACTIVATE) {
            let [x, y] = action.get_coords();
            openMenu(x, y);
            actor._backgroundManager.ignoreRelease();
        }
        return true;
    });
    clickAction.connect('clicked', function(action) {
        if (action.get_button() == 3) {
            let [x, y] = action.get_coords();
            openMenu(x, y);
        }
    });

    let grabOpBeginId = global.display.connect('grab-op-begin', function () {
        clickAction.release();
    });
    let cursorTracker = Meta.CursorTracker.get_for_screen(global.screen);

    actor.connect('destroy', function() {
        actor._backgroundMenu.destroy();
        actor._backgroundMenu = null;
        actor._backgroundManager = null;
        global.display.disconnect(grabOpBeginId);
    });

    actor.connect('notify::allocation', function() {
        // If the actor moves from underneath us, we should probably not
        // fire the long press action. It may have moved outside of the
        // range of where the cursor is, where we will never get ButtonPress
        // events
        let [xHot, yHot] = cursorTracker.get_hot();

        if (!actor.allocation.contains(xHot, yHot))
            clickAction.release();
    });
}

function addBackgroundMenu(actor, layoutManager) {
    _addBackgroundMenuFull(actor, null, layoutManager);
}

function addBackgroundMenuForAction(clickAction, layoutManager) {
    _addBackgroundMenuFull(null, clickAction, layoutManager);
}
