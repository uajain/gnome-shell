// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Atk = imports.gi.Atk;

const AppActivation = imports.ui.appActivation;
const AppFavorites = imports.ui.appFavorites;
const BackgroundMenu = imports.ui.backgroundMenu;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const GrabHelper = imports.ui.grabHelper;
const EditableLabelMode = imports.ui.editableLabel.EditableLabelMode;
const IconGrid = imports.ui.iconGrid;
const IconGridLayout = imports.ui.iconGridLayout;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const NotificationDaemon = imports.ui.notificationDaemon;
const Overview = imports.ui.overview;
const OverviewControls = imports.ui.overviewControls;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;
const ViewSelector = imports.ui.viewSelector;
const Workspace = imports.ui.workspace;
const Search = imports.ui.search;
const System = imports.ui.status.system;
const Params = imports.misc.params;
const Util = imports.misc.util;
const SystemActions = imports.misc.systemActions;

var MAX_APPLICATION_WORK_MILLIS = 75;
var MENU_POPUP_TIMEOUT = 600;
var MAX_COLUMNS = 7;
var MIN_COLUMNS = 4;
var MIN_ROWS = 1;

var INACTIVE_GRID_OPACITY = 77;
// This time needs to be less than IconGrid.EXTRA_SPACE_ANIMATION_TIME
// to not clash with other animations
var INACTIVE_GRID_OPACITY_ANIMATION_TIME = 0.24;
var FOLDER_SUBICON_FRACTION = .4;

var MIN_FREQUENT_APPS_COUNT = 3;

var INDICATORS_BASE_TIME = 0.25;
var INDICATORS_ANIMATION_DELAY = 0.125;
var INDICATORS_ANIMATION_MAX_TIME = 0.75;

var VIEWS_SWITCH_TIME = 0.4;
var VIEWS_SWITCH_ANIMATION_DELAY = 0.1;

// Follow iconGrid animations approach and divide by 2 to animate out to
// not annoy the user when the user wants to quit appDisplay.
// Also, make sure we don't exceed iconGrid animation total time or
// views switch time.
var INDICATORS_BASE_TIME_OUT = 0.125;
var INDICATORS_ANIMATION_DELAY_OUT = 0.0625;
var INDICATORS_ANIMATION_MAX_TIME_OUT =
    Math.min (VIEWS_SWITCH_TIME,
              IconGrid.ANIMATION_TIME_OUT + IconGrid.ANIMATION_MAX_DELAY_OUT_FOR_ITEM);

var PAGE_SWITCH_TIME = 0.3;

const SWITCHEROO_BUS_NAME = 'net.hadess.SwitcherooControl';
const SWITCHEROO_OBJECT_PATH = '/net/hadess/SwitcherooControl';

const SwitcherooProxyInterface = '<node> \
<interface name="net.hadess.SwitcherooControl"> \
  <property name="HasDualGpu" type="b" access="read"/> \
</interface> \
</node>';

const SwitcherooProxy = Gio.DBusProxy.makeProxyWrapper(SwitcherooProxyInterface);
let discreteGpuAvailable = false;

// Endless-specific definitions below this point

const EOS_DESKTOP_MIN_ROWS = 2;

const EOS_LINK_PREFIX = 'eos-link-';

const EOS_ENABLE_APP_CENTER_KEY = 'enable-app-center';
const EOS_APP_CENTER_ID = 'org.gnome.Software.desktop';

var EOS_INACTIVE_GRID_OPACITY = 96;
var EOS_ACTIVE_GRID_OPACITY = 255;

var EOS_INACTIVE_GRID_TRANSITION = 'easeOutQuad';
var EOS_ACTIVE_GRID_TRANSITION = 'easeInQuad';

var EOS_INACTIVE_GRID_SATURATION = 1;
var EOS_ACTIVE_GRID_SATURATION = 0;

const EOS_DRAG_OVER_FOLDER_OPACITY = 128;

const EOS_REPLACED_BY_KEY = 'X-Endless-Replaced-By';

const EOS_NEW_ICON_ANIMATION_TIME = 0.5;
const EOS_NEW_ICON_ANIMATION_DELAY = 0.7;

function _getCategories(info) {
    let categoriesStr = info.get_categories();
    if (!categoriesStr)
        return [];
    return categoriesStr.split(';');
}

function _listsIntersect(a, b) {
    for (let itemA of a)
        if (b.indexOf(itemA) >= 0)
            return true;
    return false;
}

function _getFolderName(folder) {
    let name = folder.get_string('name');

    if (folder.get_boolean('translate')) {
        let keyfile = new GLib.KeyFile();
        let path = 'desktop-directories/' + name;

        try {
            keyfile.load_from_data_dirs(path, GLib.KeyFileFlags.NONE);
            name = keyfile.get_locale_string('Desktop Entry', 'Name', null);
        } catch(e) {
            return name;
        }
    }

    return name;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

var BaseAppView = new Lang.Class({
    Name: 'BaseAppView',
    Abstract: true,

    _init: function(params, gridParams) {
        gridParams = Params.parse(gridParams, { xAlign: St.Align.MIDDLE,
                                                columnLimit: MAX_COLUMNS,
                                                minRows: MIN_ROWS,
                                                minColumns: MIN_COLUMNS,
                                                fillParent: false,
                                                padWithSpacing: true });
        params = Params.parse(params, { usePagination: false });

        if(params.usePagination)
            this._grid = new IconGrid.PaginatedIconGrid(gridParams);
        else
            this._grid = new IconGrid.IconGrid(gridParams);

        this._grid.connect('key-focus-in', Lang.bind(this, function(grid, actor) {
            this._keyFocusIn(actor);
        }));
        // Standard hack for ClutterBinLayout
        this._grid.actor.x_expand = true;

        this._items = {};
        this._allItems = [];
    },

    _keyFocusIn: function(actor) {
        // Nothing by default
    },

    _createItemForId: function(itemId) {
        if (IconGridLayout.layout.iconIsFolder(itemId))
            return Shell.DesktopDirInfo.new(itemId);

        return Shell.AppSystem.get_default().lookup_app(itemId);
    },

    _createItemIcon: function(item) {
        throw new Error('Not implemented');
    },

    getLayoutIds: function() {
        let viewId = this.getViewId();
        return IconGridLayout.layout.getIcons(viewId).slice();
    },

    _trimInvisible: function(ids) {
        let appSystem = Shell.AppSystem.get_default();
        return ids.filter((id) => {
            return IconGridLayout.layout.iconIsFolder(id) || appSystem.lookup_app(id) || (id == EOS_APP_CENTER_ID);
        });
    },

    _findIconChanges: function() {
        let oldItemLayout = this._allItems.map(function(icon) { return icon.getId(); });
        let newItemLayout = this.getLayoutIds();
        newItemLayout = this._trimInvisible(newItemLayout);

        let movedList = new Map();
        let removedList = [];
        for (let oldItemIdx in oldItemLayout) {
            let oldItem = oldItemLayout[oldItemIdx];
            let newItemIdx = newItemLayout.indexOf(oldItem);

            if (oldItemIdx != newItemIdx) {
                if (newItemIdx < 0)
                    removedList.push(oldItemIdx);
                else
                    movedList.set(oldItemIdx, newItemIdx);
            }
        }

        return [movedList, removedList];
    },

    _findAddedIcons: function() {
        let oldItemLayout = this._allItems.map(function(icon) { return icon.getId(); });
        if (oldItemLayout.length === 0)
            return [];

        let newItemLayout = this.getLayoutIds();
        newItemLayout = this._trimInvisible(newItemLayout);

        let addedIds = [];
        for (let newItem of newItemLayout) {
            let oldItemIdx = oldItemLayout.indexOf(newItem);

            if (oldItemIdx < 0)
                addedIds.push(newItem);
        }

        return addedIds;
    },

    iconsNeedRedraw: function() {
        // Check if the icons moved around
        let [movedList, removedList] = this._findIconChanges();
        if (movedList.size > 0 || removedList.length > 0)
            return true;

        // Create a map from app ids to icon objects
        let iconTable = {};
        for (let item of this._allItems)
            iconTable[item.getId()] = item;

        let layoutIds = this.getLayoutIds();

        // Iterate through all visible icons
        for (let itemId of layoutIds) {
            let item = this._createItemForId(itemId);
            if (!item)
                continue;

            // The App Center icon cannot be changed or renamed
            if (item == this._appCenterItem)
                continue;

            let currentIcon = iconTable[itemId];

            // This icon is new
            if (!currentIcon)
                return true;

            // This icon was renamed out of band
            if (currentIcon.getName() != item.get_name())
                return true;

            // currentIcon is a ViewIcon (AppIcon or FolderIcon).
            let oldIconInfo = currentIcon.getIcon();

            // item is either a ShellApp or a  ShellDesktopDirInfo.
            let newIconInfo = item.get_icon();

            // The icon image changed
            if (newIconInfo && !newIconInfo.equal(oldIconInfo))
                return true;
        }

        return false;
    },

    _loadApps: function() {
        let addedIds = this._findAddedIcons();

        this.removeAll();

        let ids = this.getLayoutIds();

        for (let itemId of ids) {
            let item = this._createItemForId(itemId);
            if (!item)
                continue;

            let icon = this._createItemIcon(item);
            if (!icon)
                continue;

            if (addedIds.indexOf(itemId) != -1)
                icon.scheduleScaleIn();

            this.addItem(icon);
        }

        this.loadGrid();
    },

    removeAll: function() {
        this._grid.destroyAll();
        this._items = {};
        this._allItems = [];
    },

    _redisplay: function(forceRedisplay) {
        if (!forceRedisplay && !this.iconsNeedRedraw())
            return;

        this._loadApps();
    },

    getAllItems: function() {
        return this._allItems;
    },

    addItem: function(icon) {
        let id = icon.id;
        if (this._items[id] !== undefined)
            return;

        this._allItems.push(icon);
        this._items[id] = icon;
    },

    _compareItems: function(a, b) {
        return a.name.localeCompare(b.name);
    },

    loadGrid: function() {
        this._allItems.forEach(Lang.bind(this, function(item) {
            this._grid.addItem(item);
        }));
        this.emit('view-loaded');
    },

    indexOf: function(icon) {
        return this._grid.indexOf(icon.actor);
    },

    getIconForIndex: function(index) {
        if (index < 0 || index >= this._allItems.length)
            return null;

        return this._allItems[index];
    },

    nudgeItemsAtIndex: function(index, location) {
        this._grid.nudgeItemsAtIndex(index, location);
    },

    removeNudgeTransforms: function() {
        this._grid.removeNudgeTransforms();
    },

    canDropAt: function(x, y, canDropPastEnd) {
        return this._grid.canDropAt(x, y, canDropPastEnd);
    },

    _selectAppInternal: function(id) {
        if (this._items[id])
            this._items[id].actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
        else
            log('No such application ' + id);
    },

    selectApp: function(id) {
        this.selectAppWithLabelMode(id, null);
    },

    selectAppWithLabelMode: function(id, labelMode) {
        if (this._items[id] && this._items[id].actor.mapped) {
            this._selectAppInternal(id);
            if (labelMode !== null)
                this._items[id].icon.setLabelMode(labelMode);
        } else if (this._items[id]) {
            // Need to wait until the view is mapped
            let signalId = this._items[id].actor.connect('notify::mapped', Lang.bind(this, function(actor) {
                if (actor.mapped) {
                    actor.disconnect(signalId);
                    this._selectAppInternal(id);
                    if (labelMode !== null)
                        this._items[id].icon.setLabelMode(labelMode);
                }
            }));
        } else {
            // Need to wait until the view is built
            let signalId = this.connect('view-loaded', Lang.bind(this, function() {
                this.disconnect(signalId);
                this.selectAppWithLabelMode(id, labelMode);
            }));
        }
    },

    _doSpringAnimation: function(animationDirection) {
        this._grid.actor.opacity = 255;

        // We don't do the icon grid animations on Endless, but we still need
        // to call this method so that the animation-done signal gets emitted,
        // in order not to break the transitoins.
        this._grid.animateSpring(animationDirection, null);
    },

    animate: function(animationDirection, onComplete) {
        if (onComplete) {
            let animationDoneId = this._grid.connect('animation-done', Lang.bind(this,
                function () {
                    this._grid.disconnect(animationDoneId);
                    onComplete();
            }));
        }

        if (animationDirection == IconGrid.AnimationDirection.IN) {
            let id = this._grid.actor.connect('paint', () => {
                this._grid.actor.disconnect(id);
                this._doSpringAnimation(animationDirection);
            });
        } else {
            this._doSpringAnimation(animationDirection);
        }
    },

    animateSwitch: function(animationDirection) {
        Tweener.removeTweens(this.actor);
        Tweener.removeTweens(this._grid.actor);

        let params = { time: VIEWS_SWITCH_TIME,
                       transition: 'easeOutQuad' };
        if (animationDirection == IconGrid.AnimationDirection.IN) {
            this.actor.show();
            params.opacity = 255;
            params.delay = VIEWS_SWITCH_ANIMATION_DELAY;
        } else {
            params.opacity = 0;
            params.delay = 0;
            params.onComplete = Lang.bind(this, function() { this.actor.hide() });
        }

        Tweener.addTween(this._grid.actor, params);
    },

    get gridActor() {
        return this._grid.actor;
    }
});
Signals.addSignalMethods(BaseAppView.prototype);

var PageIndicatorsActor = new Lang.Class({
    Name:'PageIndicatorsActor',
    Extends: St.BoxLayout,

    _init: function() {
        this.parent({ style_class: 'page-indicators',
                      vertical: true,
                      x_expand: true, y_expand: true,
                      x_align: Clutter.ActorAlign.END,
                      y_align: Clutter.ActorAlign.CENTER,
                      reactive: true,
                      clip_to_allocation: true });
    },

    vfunc_get_preferred_height: function(forWidth) {
        // We want to request the natural height of all our children as our
        // natural height, so we chain up to St.BoxLayout, but we only request 0
        // as minimum height, since it's not that important if some indicators
        // are not shown
        let [, natHeight] = this.parent(forWidth);
        return [0, natHeight];
    }
});

var PageIndicators = new Lang.Class({
    Name:'PageIndicators',

    _init: function() {
        this.actor = new PageIndicatorsActor();
        this._nPages = 0;
        this._currentPage = undefined;

        this.actor.connect('notify::mapped',
                           Lang.bind(this, function() {
                               this.animateIndicators(IconGrid.AnimationDirection.IN);
                           })
                          );
    },

    setNPages: function(nPages) {
        if (this._nPages == nPages)
            return;

        let diff = nPages - this._nPages;
        if (diff > 0) {
            for (let i = 0; i < diff; i++) {
                let pageIndex = this._nPages + i;
                let indicator = new St.Button({ style_class: 'page-indicator',
                                                button_mask: St.ButtonMask.ONE |
                                                             St.ButtonMask.TWO |
                                                             St.ButtonMask.THREE,
                                                toggle_mode: true,
                                                checked: pageIndex == this._currentPage });
                indicator.child = new St.Widget({ style_class: 'page-indicator-icon' });
                indicator.connect('clicked', Lang.bind(this,
                    function() {
                        this.emit('page-activated', pageIndex);
                    }));
                this.actor.add_actor(indicator);
            }
        } else {
            let children = this.actor.get_children().splice(diff);
            for (let i = 0; i < children.length; i++)
                children[i].destroy();
        }
        this._nPages = nPages;
        this.actor.visible = (this._nPages > 1);
    },

    setCurrentPage: function(currentPage) {
        this._currentPage = currentPage;

        let children = this.actor.get_children();
        for (let i = 0; i < children.length; i++)
            children[i].set_checked(i == this._currentPage);
    },

    animateIndicators: function(animationDirection) {
        if (!this.actor.mapped)
            return;

        let children = this.actor.get_children();
        if (children.length == 0)
            return;

        for (let i = 0; i < this._nPages; i++)
            Tweener.removeTweens(children[i]);

        let offset;
        if (this.actor.get_text_direction() == Clutter.TextDirection.RTL)
            offset = -children[0].width;
        else
            offset = children[0].width;

        let isAnimationIn = animationDirection == IconGrid.AnimationDirection.IN;
        let delay = isAnimationIn ? INDICATORS_ANIMATION_DELAY :
                                    INDICATORS_ANIMATION_DELAY_OUT;
        let baseTime = isAnimationIn ? INDICATORS_BASE_TIME : INDICATORS_BASE_TIME_OUT;
        let totalAnimationTime = baseTime + delay * this._nPages;
        let maxTime = isAnimationIn ? INDICATORS_ANIMATION_MAX_TIME :
                                      INDICATORS_ANIMATION_MAX_TIME_OUT;
        if (totalAnimationTime > maxTime)
            delay -= (totalAnimationTime - maxTime) / this._nPages;

        for (let i = 0; i < this._nPages; i++) {
            children[i].translation_x = isAnimationIn ? offset : 0;
            Tweener.addTween(children[i],
                             { translation_x: isAnimationIn ? 0 : offset,
                               time: baseTime + delay * i,
                               transition: 'easeInOutQuad',
                               delay: isAnimationIn ? VIEWS_SWITCH_ANIMATION_DELAY : 0
                             });
        }
    }
});
Signals.addSignalMethods(PageIndicators.prototype);

var AllViewContainer = new Lang.Class({
    Name: 'AllViewContainer',
    Extends: St.Widget,

    _init: function(gridActor, params) {
        params = Params.parse(params, { allowScrolling: true });

        this.parent({ layout_manager: new Clutter.BinLayout(),
                      x_expand: true,
                      y_expand: true });

        this.gridActor = gridActor;

        gridActor.y_expand = true;
        gridActor.y_align = Clutter.ActorAlign.START;

        this.scrollView = new St.ScrollView({ style_class: 'all-apps-scroller',
                                              x_expand: true,
                                              y_expand: true,
                                              x_fill: true,
                                              y_fill: false,
                                              reactive: params.allowScrolling,
                                              hscrollbar_policy: Gtk.PolicyType.NEVER,
                                              vscrollbar_policy: Gtk.PolicyType.EXTERNAL,
                                              y_align: Clutter.ActorAlign.START });

        this.stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this.stackBox = new St.BoxLayout({ vertical: true });

        this.stack.add_child(gridActor);
        this.stackBox.add_child(this.stack);

        // For some reason I couldn't investigate yet using add_child()
        // here makes the icon grid not to show up on the desktop.
        this.scrollView.add_actor(this.stackBox);

        this.add_child(this.scrollView);
    }
});

var AllView = new Lang.Class({
    Name: 'AllView',
    Extends: BaseAppView,

    _init: function() {
        this.parent({ usePagination: true },
                    { minRows: EOS_DESKTOP_MIN_ROWS });
        this.actor = new AllViewContainer(this._grid.actor);
        this.actor._delegate = this;

        this._scrollView = this.actor.scrollView;
        this._stack = this.actor.stack;
        this._stackBox = this.actor.stackBox;

        this._adjustment = this._scrollView.vscroll.adjustment;

        this._pageIndicators = new PageIndicators();
        this._pageIndicators.connect('page-activated', Lang.bind(this,
            function(indicators, pageIndex) {
                this.goToPage(pageIndex);
            }));
        this._pageIndicators.actor.connect('scroll-event', Lang.bind(this, this._onScroll));
        this.actor.add_actor(this._pageIndicators.actor);

        this.folderIcons = [];

        this._grid.currentPage = 0;
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker);

        this._scrollView.connect('scroll-event', Lang.bind(this, this._onScroll));

        let panAction = new Clutter.PanAction({ interpolate: false });
        panAction.connect('pan', Lang.bind(this, this._onPan));
        panAction.connect('gesture-cancel', Lang.bind(this, this._onPanEnd));
        panAction.connect('gesture-end', Lang.bind(this, this._onPanEnd));
        this._panAction = panAction;
        this._panning = false;

        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('clicked', Lang.bind(this, function() {
            if (!this._currentPopup)
                return;

            let [x, y] = this._clickAction.get_coords();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            if (!this._currentPopup.actor.contains(actor))
                this._currentPopup.popdown();
        }));
        Main.overview.addAction(this._clickAction, false);
        this._eventBlocker.bind_property('reactive', this._clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);

        this._bgAction = new Clutter.ClickAction();
        Main.overview.addAction(this._bgAction, true);
        BackgroundMenu.addBackgroundMenuForAction(this._bgAction, Main.layoutManager);
        this._clickAction.bind_property('enabled', this._bgAction, 'enabled',
                                        GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);
        this.actor.bind_property('mapped', this._bgAction, 'enabled',
                                 GObject.BindingFlags.SYNC_CREATE);

        this._appCenterIcon = null;

        this._displayingPopup = false;

        this._currentPopup = null;

        this._dragView = null;
        this._dragIcon = null;
        this._insertIdx = -1;
        this._onIconIdx = -1;
        this._lastCursorLocation = -1;

        this._availWidth = 0;
        this._availHeight = 0;

        Main.overview.connect('item-drag-begin', this._onDragBegin.bind(this));
        Main.overview.connect('item-drag-end', this._onDragEnd.bind(this));
        this._grid.connect('space-opened', Lang.bind(this,
            function() {
                let fadeEffect = this._scrollView.get_effect('fade');
                if (fadeEffect)
                    fadeEffect.enabled = false;

                this.emit('space-ready');
            }));
        this._grid.connect('space-closed', Lang.bind(this,
            function() {
                this._displayingPopup = false;
            }));

        this.actor.connect('notify::mapped', Lang.bind(this,
            function() {
                if (this.actor.mapped) {
                    this._keyPressEventId =
                        global.stage.connect('key-press-event',
                                             Lang.bind(this, this._onKeyPressEvent));
                } else {
                    if (this._keyPressEventId)
                        global.stage.disconnect(this._keyPressEventId);
                    this._keyPressEventId = 0;
                }
            }));

        this._redisplayWorkId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._redisplay));

        Shell.AppSystem.get_default().connect('installed-changed', Lang.bind(this, function() {
            Main.queueDeferredWork(this._redisplayWorkId);
        }));
        IconGridLayout.layout.connect('changed', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });
        global.settings.connect('changed::' + EOS_ENABLE_APP_CENTER_KEY, () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });

        this._addedFolderId = null;
        IconGridLayout.layout.connect('folder-added', (iconGridLayout, id) => {
            // Go to last page; ideally the grid should know in
            // which page the change took place and show it automatically
            // which would avoid us having to navigate there directly
            this.goToPage(this._grid.nPages() - 1);

            // Save the folder ID so we know which one was added
            // and set it to edit mode
            this._addedFolderId = id;
        });
    },

    loadGrid: function() {
        this._maybeAddAppCenterIcon();
        this.parent();
    },

    getLayoutIds: function() {
        let layoutIds = this.parent();

        if (!global.settings.get_boolean(EOS_ENABLE_APP_CENTER_KEY))
            return layoutIds;

        let appSys = Shell.AppSystem.get_default();
        if (appSys.lookup_app(EOS_APP_CENTER_ID)) {
            // AllView also has the App Center icon appended at the end of the list.
            // For Drag n' Drop work correctly, we must take this icon into account
            // when calculating the diff between before and after the DnD.
            layoutIds.push(EOS_APP_CENTER_ID);
        }

        return layoutIds;
    },

    removeAll: function() {
        this.folderIcons = [];
        this._appCenterIcon = null;
        this.parent();
    },

    _itemNameChanged: function(item) {
        // If an item's name changed, we can pluck it out of where it's
        // supposed to be and reinsert it where it's sorted.
        let oldIdx = this._allItems.indexOf(item);
        this._allItems.splice(oldIdx, 1);
        let newIdx = Util.insertSorted(this._allItems, item, this._compareItems);

        this._grid.removeItem(item);
        this._grid.addItem(item, newIdx);
    },

    _ensureAppCenterIcon: function() {
        if (this._appCenterIcon)
            return;

        this._appCenterIcon = new AppCenterIcon(this);
        this._appCenterItem = {
            get_name: () => { return this._appCenterIcon.getName(); }
        };
    },

    _createItemForId: function(itemId) {
        if (itemId == EOS_APP_CENTER_ID) {
            this._ensureAppCenterIcon();
            return this._appCenterItem;
        }

        return this.parent(itemId);
    },

    _createItemIcon: function(item) {
        if (item == this._appCenterItem)
            return this._appCenterIcon;

        let itemId = item.get_id();

        if (!IconGridLayout.layout.iconIsFolder(itemId)) {
            return new AppIcon(item,
                               { isDraggable: true,
                                 parentView: this },
                               null);
        }

        let icon = new FolderIcon(item, this);
        icon.connect('name-changed', this._itemNameChanged.bind(this));
        this.folderIcons.push(icon);
        if (this._addedFolderId == itemId) {
            this.selectAppWithLabelMode(this._addedFolderId, EditableLabelMode.EDIT);
            this._addedFolderId = null;
        }

        return icon;
    },

    _maybeAddAppCenterIcon: function() {
        if (this._appCenterIcon)
            return;

        if (!global.settings.get_boolean(EOS_ENABLE_APP_CENTER_KEY))
            return;

        let appSys = Shell.AppSystem.get_default();
        if (!appSys.lookup_app(EOS_APP_CENTER_ID)) {
            log('App center ' + EOS_APP_CENTER_ID + ' is not installed');
            return;
        }

        this._ensureAppCenterIcon();
        this.addItem(this._appCenterIcon);
    },

    // Overriden from BaseAppView
    animate: function (animationDirection, onComplete) {
        this._scrollView.reactive = false;
        let completionFunc = Lang.bind(this, function() {
            this._scrollView.reactive = true;
            if (onComplete)
                onComplete();
        });

        if (animationDirection == IconGrid.AnimationDirection.OUT &&
            this._displayingPopup && this._currentPopup) {
            this._currentPopup.popdown();
            let spaceClosedId = this._grid.connect('space-closed', Lang.bind(this,
                function() {
                    this._grid.disconnect(spaceClosedId);
                    // Given that we can't call this.parent() inside the
                    // signal handler, call again animate which will
                    // call the parent given that popup is already
                    // closed.
                    this.animate(animationDirection, completionFunc);
                }));
        } else {
            this.parent(animationDirection, completionFunc);
            if (animationDirection == IconGrid.AnimationDirection.OUT)
                this._pageIndicators.animateIndicators(animationDirection);
        }
    },

    animateSwitch: function(animationDirection) {
        this.parent(animationDirection);

        if (this._currentPopup && this._displayingPopup &&
            animationDirection == IconGrid.AnimationDirection.OUT)
            Tweener.addTween(this._currentPopup.actor,
                             { time: VIEWS_SWITCH_TIME,
                               transition: 'easeOutQuad',
                               opacity: 0,
                               onComplete: function() {
                                  this.opacity = 255;
                               } });

        if (animationDirection == IconGrid.AnimationDirection.OUT)
            this._pageIndicators.animateIndicators(animationDirection);
    },

    getCurrentPageY: function() {
        return this._grid.getPageY(this._grid.currentPage);
    },

    goToPage: function(pageNumber) {
        pageNumber = clamp(pageNumber, 0, this._grid.nPages() - 1);

        if (this._grid.currentPage == pageNumber && this._displayingPopup && this._currentPopup)
            return;
        if (this._displayingPopup && this._currentPopup)
            this._currentPopup.popdown();

        let velocity;
        if (!this._panning)
            velocity = 0;
        else
            velocity = Math.abs(this._panAction.get_velocity(0)[2]);
        // Tween the change between pages.
        // If velocity is not specified (i.e. scrolling with mouse wheel),
        // use the same speed regardless of original position
        // if velocity is specified, it's in pixels per milliseconds
        let diffToPage = this._diffToPage(pageNumber);
        let childBox = this._scrollView.get_allocation_box();
        let totalHeight = childBox.y2 - childBox.y1;
        let time;
        // Only take the velocity into account on page changes, otherwise
        // return smoothly to the current page using the default velocity
        if (this._grid.currentPage != pageNumber) {
            let minVelocity = totalHeight / (PAGE_SWITCH_TIME * 1000);
            velocity = Math.max(minVelocity, velocity);
            time = (diffToPage / velocity) / 1000;
        } else {
            time = PAGE_SWITCH_TIME * diffToPage / totalHeight;
        }
        // When changing more than one page, make sure to not take
        // longer than PAGE_SWITCH_TIME
        time = Math.min(time, PAGE_SWITCH_TIME);

        this._grid.currentPage = pageNumber;
        Tweener.addTween(this._adjustment,
                         { value: this._grid.getPageY(this._grid.currentPage),
                           time: time,
                           transition: 'easeOutQuad' });
        this._pageIndicators.setCurrentPage(pageNumber);
    },

    _diffToPage: function (pageNumber) {
        let currentScrollPosition = this._adjustment.value;
        return Math.abs(currentScrollPosition - this._grid.getPageY(pageNumber));
    },

    openSpaceForPopup: function(item, side, nRows) {
        this._updateIconOpacities(true);
        this._displayingPopup = true;
        this._grid.openExtraSpace(item, side, nRows);
    },

    _closeSpaceForPopup: function() {
        this._updateIconOpacities(false);

        let fadeEffect = this._scrollView.get_effect('fade');
        if (fadeEffect)
            fadeEffect.enabled = true;

        this._grid.closeExtraSpace();
    },

    _onScroll: function(actor, event) {
        if (this._displayingPopup || !this._scrollView.reactive)
            return Clutter.EVENT_STOP;

        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP)
            this.goToPage(this._grid.currentPage - 1);
        else if (direction == Clutter.ScrollDirection.DOWN)
            this.goToPage(this._grid.currentPage + 1);

        return Clutter.EVENT_STOP;
    },

    _onPan: function(action) {
        if (this._displayingPopup)
            return false;
        this._panning = true;
        this._clickAction.release();
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this._adjustment;
        adjustment.value -= (dy / this._scrollView.height) * adjustment.page_size;
        return false;
    },

    _onPanEnd: function(action) {
         if (this._displayingPopup)
            return;

        let pageHeight = this._grid.getPageHeight();

        // Calculate the scroll value we'd be at, which is our current
        // scroll plus any velocity the user had when they released
        // their finger.

        let velocity = -action.get_velocity(0)[2];
        let endPanValue = this._adjustment.value + velocity;

        let closestPage = Math.round(endPanValue / pageHeight);
        this.goToPage(closestPage);

        this._panning = false;
    },

    _onKeyPressEvent: function(actor, event) {
        if (this._displayingPopup)
            return Clutter.EVENT_STOP;

        if (event.get_key_symbol() == Clutter.Page_Up) {
            this.goToPage(this._grid.currentPage - 1);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() == Clutter.Page_Down) {
            this.goToPage(this._grid.currentPage + 1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    getViewId: function() {
        return IconGridLayout.DESKTOP_GRID_ID;
    },

    _positionReallyMoved: function() {
        if (this._insertIdx == -1)
            return false;

        // If we're immediately right of the original position,
        // we didn't really move
        if ((this._insertIdx == this._originalIdx ||
             this._insertIdx == this._originalIdx + 1) &&
            this._dragView == this._dragIcon.parentView)
            return false;

        return true;
    },

    _resetNudgeState: function() {
        if (this._dragView)
            this._dragView.removeNudgeTransforms();
    },

    _resetDragViewState: function() {
        this._resetNudgeState();

        this._insertIdx = -1;
        this._onIconIdx = -1;
        this._lastCursorLocation = -1;
        this._dragView = null;
    },

    _setupDragState: function(source) {
        if (!source || !source.parentView)
            return;

        if (!source.handleViewDragBegin)
            return;

        this._dragIcon = source;
        this._originalIdx = source.parentView.indexOf(source);

        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this)
        };
        DND.addDragMonitor(this._dragMonitor);

        this._resetDragViewState();

        source.handleViewDragBegin();
        if (this._appCenterIcon && (source.canDragOver(this._appCenterIcon)))
            this._appCenterIcon.handleViewDragBegin();
    },

    _clearDragState: function(source) {
        if (!source || !source.parentView)
            return;

        if (!source.handleViewDragEnd)
            return;

        this._dragIcon = null;
        this._originalIdx = -1;

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }

        this._resetDragViewState();

        source.handleViewDragEnd();
        if (this._appCenterIcon && (source.canDragOver(this._appCenterIcon)))
            this._appCenterIcon.handleViewDragEnd();
    },

    _onDragBegin: function(overview, source) {
        // Save the currently dragged item info
        this._setupDragState(source);
    },

    _onDragEnd: function(overview, source) {
        this._clearDragState(source);
    },

    _onDragMotion: function(dragEvent) {
        // If the icon is dragged to the top or the bottom of the grid,
        // we want to scroll it, if possible
        if (this._handleDragOvershoot(dragEvent)) {
            this._resetDragViewState();
            return DND.DragMotionResult.CONTINUE;
        }
        // Handle motion over grid
        let dragView = null;

        if (this._dragIcon.parentView.actor.contains(dragEvent.targetActor))
            dragView = this._dragIcon.parentView;
        else if (this.actor.contains(dragEvent.targetActor))
            dragView = this;

        if (dragView != this._dragView) {
            if (this._dragView && this._onIconIdx > -1)
                this._setDragHoverState(false);

            this._resetDragViewState();
            this._dragView = dragView;
        }

        if (!this._dragView)
            return DND.DragMotionResult.CONTINUE;

        let draggingWithinFolder =
            this._currentPopup && (this._dragView == this._dragIcon.parentView);
        let canDropPastEnd = draggingWithinFolder || !this._appCenterIcon;

        // Ask grid can we drop here
        let [idx, cursorLocation] = this._dragView.canDropAt(dragEvent.x,
                                                             dragEvent.y,
                                                             canDropPastEnd);

        let onIcon = (cursorLocation == IconGrid.CursorLocation.ON_ICON);
        let isNewPosition = (!onIcon && idx != this._insertIdx) ||
            (cursorLocation != this._lastCursorLocation);

        // If we are not over our last hovered icon, remove its hover state
        if (this._onIconIdx != -1 &&
            ((idx != this._onIconIdx) || !onIcon)) {
            this._setDragHoverState(false);
            dragEvent.dragActor.opacity = EOS_ACTIVE_GRID_OPACITY;
        }

        // If we are in a new spot, remove the previous nudges
        if (isNewPosition)
            this._resetNudgeState();

        // Update our insert/hover index and the last cursor location
        this._lastCursorLocation = cursorLocation;
        if (onIcon) {
            this._onIconIdx = idx;
            this._insertIdx = -1;

            let hoverResult = this._getDragHoverResult();
            if (hoverResult == DND.DragMotionResult.MOVE_DROP) {
                // If we are hovering over a drop target, set its hover state
                this._setDragHoverState(true);
                dragEvent.dragActor.opacity = EOS_DRAG_OVER_FOLDER_OPACITY;
            }

            return hoverResult;
        }

        // Dropping in a space between icons
        this._onIconIdx = -1;
        this._insertIdx = idx;

        if (this._shouldNudgeItems(isNewPosition))
            this._dragView.nudgeItemsAtIndex(this._insertIdx, cursorLocation);

        // Propagate the signal in any case when moving icons
        return DND.DragMotionResult.CONTINUE;
    },

    _handleDragOvershoot: function(dragEvent) {
        let [ gridX, gridY ] = this.actor.get_transformed_position();
        let [ gridW, gridH ] = this.actor.get_transformed_size();
        let gridBottom = gridY + gridH;

        if (dragEvent.y > gridY && dragEvent.y < gridBottom) {
            // We're within the grid boundaries - cancel any existing
            // scrolling
            if (Tweener.isTweening(this._adjustment))
                Tweener.removeTweens(this._adjustment);

            return false;
        }

        if (dragEvent.y <= gridY &&
            this._adjustment.value > 0) {
            this.goToPage(this._grid.currentPage - 1);
            return true;
        }

        let maxAdjust = this._adjustment.upper - this._adjustment.page_size;
        if (dragEvent.y >= gridBottom &&
            this._adjustment.value < maxAdjust) {
            this.goToPage(this._grid.currentPage + 1);
            return true;
        }

        return false;
    },

    _shouldNudgeItems: function(isNewPosition) {
        return (isNewPosition && this._positionReallyMoved());
    },

    _setDragHoverState: function(state) {
        let viewIcon = this._dragView.getIconForIndex(this._onIconIdx);

        if (viewIcon && this._dragIcon.canDragOver(viewIcon))
            viewIcon.setDragHoverState(state);
    },

    _getDragHoverResult: function() {
        // If we are hovering over our own icon placeholder, ignore it
        if (this._onIconIdx == this._originalIdx &&
            this._dragView == this._dragIcon.parentView)
            return DND.DragMotionResult.NO_DROP;

        let validHoverDrop = false;
        let viewIcon = this._dragView.getIconForIndex(this._onIconIdx);

        // We can only move applications into folders or the app store
        if (viewIcon)
            validHoverDrop = viewIcon.canDrop && this._dragIcon.canDragOver(viewIcon);

        if (validHoverDrop)
            return DND.DragMotionResult.MOVE_DROP;

        return DND.DragMotionResult.CONTINUE;
    },

    acceptDrop: function(source, actor, x, y, time) {
        let position = [x, y];

        // This makes sure that if we dropped an icon outside of the grid,
        // we use the root grid as our target. This can only happen when
        // dragging an icon out of a folder
        if (this._dragView == null)
            this._dragView = this;

        let droppedOutsideOfFolder = this._currentPopup && (this._dragView != this._dragIcon.parentView);
        let dropIcon = this._dragView.getIconForIndex(this._onIconIdx);
        let droppedOnAppOutsideOfFolder = droppedOutsideOfFolder && dropIcon && !dropIcon.canDrop;

        if (this._onIconIdx != -1 && !droppedOnAppOutsideOfFolder) {
            // Find out what icon the drop is under
            if (!dropIcon || !dropIcon.canDrop)
                return false;

            if (!source.canDragOver(dropIcon))
                return false;

            let accepted  = dropIcon.handleIconDrop(source);
            if (!accepted)
                return false;

            if (this._currentPopup) {
                this._eventBlocker.reactive = false;
                this._currentPopup.popdown();
            }

            return true;
        }

        // If we are not dropped outside of a folder (allowed move) and we're
        // outside of the grid area, or didn't actually change position, ignore
        // the request to move
        if (!this._positionReallyMoved() && !droppedOutsideOfFolder)
            return false;

        // If we are not over an icon but within the grid, shift the
        // grid around to accomodate it
        let icon = this._dragView.getIconForIndex(this._insertIdx);
        let insertId = icon ? icon.getId() : null;
        let folderId = this._dragView.getViewId();

        // If we dropped the icon outside of the folder, close the popup and
        // add the icon to the main view
        if (droppedOutsideOfFolder) {
            source.blockHandler = true;
            this._eventBlocker.reactive = false;
            this._currentPopup.popdown();
        }

        IconGridLayout.layout.repositionIcon(source.getId(), insertId, folderId);
        return true;
    },

    addFolderPopup: function(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', Lang.bind(this,
            function(popup, isOpen) {
                this._eventBlocker.reactive = isOpen;
                this._currentPopup = isOpen ? popup : null;
                this._updateIconOpacities(isOpen);
                if(!isOpen)
                    this._closeSpaceForPopup();
            }));
    },

    _keyFocusIn: function(icon) {
        let itemPage = this._grid.getItemPage(icon);
        this.goToPage(itemPage);
    },

    _updateIconOpacities: function(folderOpen) {
        for (let id in this._items) {
            let params, opacity;
            if (folderOpen && !this._items[id].actor.checked)
                opacity =  INACTIVE_GRID_OPACITY;
            else
                opacity = 255;
            params = { opacity: opacity,
                       time: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                       transition: 'easeOutQuad' };
            Tweener.addTween(this._items[id].actor, params);
        }
    },

    // Called before allocation to calculate dynamic spacing
    adaptToSize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._scrollView.get_theme_node().get_content_box(box);
        box = this._stackBox.get_theme_node().get_content_box(box);
        box = this._stack.get_theme_node().get_content_box(box);
        box = this._grid.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let oldNPages = this._grid.nPages();

        this._grid.adaptToSize(availWidth, availHeight);

        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this._scrollView.update_fade_effect(fadeOffset, 0);
        if (fadeOffset > 0)
            this._scrollView.get_effect('fade').fade_edges = true;

        if (this._availWidth != availWidth || this._availHeight != availHeight || oldNPages != this._grid.nPages()) {
            this._adjustment.value = 0;
            this._grid.currentPage = 0;
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
                function() {
                    this._pageIndicators.setNPages(this._grid.nPages());
                    this._pageIndicators.setCurrentPage(0);
                }));
        }

        this._availWidth = availWidth;
        this._availHeight = availHeight;
        // Update folder views
        for (let i = 0; i < this.folderIcons.length; i++)
            this.folderIcons[i].adaptToSize(availWidth, availHeight);

        // Enable panning depending on the number of pages
        this._scrollView.remove_action(this._panAction);
        if (this._grid.nPages() > 1)
            this._scrollView.add_action(this._panAction);
    }
});
Signals.addSignalMethods(AllView.prototype);

var FrequentView = new Lang.Class({
    Name: 'FrequentView',
    Extends: BaseAppView,

    _init: function() {
        this.parent(null, { fillParent: true });

        this.actor = new St.Widget({ style_class: 'frequent-apps',
                                     layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, y_expand: true });

        this._noFrequentAppsLabel = new St.Label({ text: _("Frequently used applications will appear here"),
                                                   style_class: 'no-frequent-applications-label',
                                                   x_align: Clutter.ActorAlign.CENTER,
                                                   x_expand: true,
                                                   y_align: Clutter.ActorAlign.CENTER,
                                                   y_expand: true });

        this._grid.actor.y_expand = true;

        this.actor.add_actor(this._grid.actor);
        this.actor.add_actor(this._noFrequentAppsLabel);
        this._noFrequentAppsLabel.hide();

        this._usage = Shell.AppUsage.get_default();

        this.actor.connect('notify::mapped', Lang.bind(this, function() {
            if (this.actor.mapped)
                this._redisplay();
        }));
    },

    hasUsefulData: function() {
        return this._usage.get_most_used("").length >= MIN_FREQUENT_APPS_COUNT;
    },

    _loadApps: function() {
        let mostUsed = this._usage.get_most_used ("");
        let hasUsefulData = this.hasUsefulData();
        this._noFrequentAppsLabel.visible = !hasUsefulData;
        if(!hasUsefulData)
            return;

        for (let i = 0; i < mostUsed.length; i++) {
            if (!mostUsed[i].get_app_info().should_show())
                continue;
            let appIcon = new AppIcon(mostUsed[i],
                                      { isDraggable: true },
                                      null);
            this._grid.addItem(appIcon, -1);
        }
    },

    // Called before allocation to calculate dynamic spacing
    adaptToSize: function(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._grid.actor.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._grid.adaptToSize(availWidth, availHeight);
    }
});

var Views = {
    ALL: 0
};

var ControlsBoxLayout = Lang.Class({
    Name: 'ControlsBoxLayout',
    Extends: Clutter.BoxLayout,

    /**
     * Override the BoxLayout behavior to use the maximum preferred width of all
     * buttons for each child
     */
    vfunc_get_preferred_width: function(container, forHeight) {
        let maxMinWidth = 0;
        let maxNaturalWidth = 0;
        for (let child = container.get_first_child();
             child;
             child = child.get_next_sibling()) {
             let [minWidth, natWidth] = child.get_preferred_width(forHeight);
             maxMinWidth = Math.max(maxMinWidth, minWidth);
             maxNaturalWidth = Math.max(maxNaturalWidth, natWidth);
        }
        let childrenCount = container.get_n_children();
        let totalSpacing = this.spacing * (childrenCount - 1);
        return [maxMinWidth * childrenCount + totalSpacing,
                maxNaturalWidth * childrenCount + totalSpacing];
    }
});

var AppDisplay = new Lang.Class({
    Name: 'AppDisplay',

    _init: function() {
        this._privacySettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.privacy' });
        this._allView = new AllView();

        this.actor = new St.Widget({ style_class: 'all-apps',
                                     x_expand: true,
                                     y_expand: true,
                                     layout_manager: new Clutter.BinLayout() });

        this.actor.add_actor(this._allView.actor);
        this._showView();
    },

    animate: function(animationDirection, onComplete) {
        this._allView.animate(animationDirection, onComplete);
    },

    _showView: function() {
        this._allView.animateSwitch(IconGrid.AnimationDirection.IN);
    },

    selectApp: function(id) {
        this._showView();
        this._allView.selectApp(id);
    },

    adaptToSize: function(width, height) {
        return this._allView.adaptToSize(width, height);
    },

    get gridContainer() {
        return this._allView.actor;
    },

    get gridActor() {
        return this._allView.gridActor;
    }
})

var AppSearchProvider = new Lang.Class({
    Name: 'AppSearchProvider',

    _init: function() {
        this._appSys = Shell.AppSystem.get_default();
        this.id = 'applications';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._systemActions = new SystemActions.getDefault();
    },

    getResultMetas: function(apps, callback) {
        let metas = [];
        for (let id of apps) {
            if (id.endsWith('.desktop')) {
                let app = this._appSys.lookup_app(id);

                metas.push({ 'id': app.get_id(),
                             'name': app.get_name(),
                             'createIcon': function(size) {
                                 return app.create_icon_texture(size);
                           }
                });
            } else {
                let name = this._systemActions.getName(id);
                let iconName = this._systemActions.getIconName(id);

                let createIcon = size => new St.Icon({ icon_name: iconName,
                                                       width: size,
                                                       height: size,
                                                       style_class: 'system-action-icon' });

                metas.push({ id, name, createIcon });
            }
        }

        callback(metas);
    },

    filterResults: function(results, maxNumber) {
        return results.slice(0, maxNumber);
    },

    getInitialResultSet: function(terms, callback, cancellable) {
        let query = terms.join(' ');
        let groups = Shell.AppSystem.search(query);
        let usage = Shell.AppUsage.get_default();
        let results = [];
        let codingEnabled = global.settings.get_boolean('enable-coding-game');
        let codingApps = [
            'com.endlessm.Coding.Chatbox.desktop',
            'eos-shell-extension-prefs.desktop'
        ];
        let replacementMap = {};

        groups.forEach(function(group) {
            group = group.filter(function(appID) {
                let app = Gio.DesktopAppInfo.new(appID);
                let isLink = appID.startsWith(EOS_LINK_PREFIX);
                let isOnDesktop = IconGridLayout.layout.hasIcon(appID);

                // exclude links that are not part of the desktop grid
                if (!(app && app.should_show() && !(isLink && !isOnDesktop)))
                    return false;

                // exclude coding related apps if coding game is not enabled
                if (!codingEnabled && codingApps.indexOf(appID) > -1)
                    return false;

                if (app && app.should_show()) {
                    let replacedByID = app.get_string(EOS_REPLACED_BY_KEY);
                    if (replacedByID)
                        replacementMap[appID] = replacedByID;

                    return true;
                }

                return false;
            });
            results = results.concat(group.sort(function(a, b) {
                return usage.compare('', a, b);
            }));
        });

        results = results.concat(this._systemActions.getMatchingActions(terms));

        // resort to keep results on the desktop grid before the others
        results = results.sort(function(a, b) {
            let hasA = IconGridLayout.layout.hasIcon(a);
            let hasB = IconGridLayout.layout.hasIcon(b);

            if (hasA)
                return -1;
            if (hasB)
                return 1;

            return 0;
        });

        // perform replacements by removing replaceable apps
        results = results.filter(function(appID) {
            let replacedByID = replacementMap[appID];

            // this app does not specify any replacements, show it
            if (!replacedByID)
                return true;

            // the specified replacement is not installed, show it
            let replacedByApp = Gio.DesktopAppInfo.new(replacedByID);
            if (!replacedByApp)
                return true;

            // the specified replacement is installed, hide it
            return false;
        });

        callback(results);
    },

    getSubsearchResultSet: function(previousResults, terms, callback, cancellable) {
        this.getInitialResultSet(terms, callback, cancellable);
    },

    activateResult: function(appId) {
        let event = Clutter.get_current_event();
        let app = this._appSys.lookup_app(appId);
        let activationContext = new AppActivation.AppActivationContext(app);
        activationContext.activate(event);
    },

    createResultObject: function (resultMeta) {
        // We only use this code path for SystemActions which, from the point
        // of view of this method, are those NOT referenced with desktop IDs.
        if (!resultMeta.id.endsWith('.desktop'))
            return new SystemActionIcon(this, resultMeta);
    }
});

var FolderView = new Lang.Class({
    Name: 'FolderView',
    Extends: BaseAppView,

    _init: function(folderIcon, dirInfo) {
        this.parent(null, null);

        this._folderIcon = folderIcon;
        this._dirInfo = dirInfo;

        // If it not expand, the parent doesn't take into account its preferred_width when allocating
        // the second time it allocates, so we apply the "Standard hack for ClutterBinLayout"
        this._grid.actor.x_expand = true;

        this.actor = new St.ScrollView({ overlay_scrollbars: true });
        this.actor.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        let scrollableContainer = new St.BoxLayout({ vertical: true, reactive: true });
        this._noAppsLabel = new St.Label({ text: _("No apps in this folder! To add an app, drag it onto the folder."),
                                           style_class: 'folder-no-apps-label'});
        scrollableContainer.add_actor(this._noAppsLabel);
        scrollableContainer.add_actor(this._grid.actor);
        this.actor.add_actor(scrollableContainer);

        let action = new Clutter.PanAction({ interpolate: true });
        action.connect('pan', Lang.bind(this, this._onPan));
        this.actor.add_action(action);

        this.actor.connect('notify::mapped', (actor) => {
            // The only way to make the folder popover get the correct sizing
            // is by removing and re-adding all the icons. To not hit the
            // performance too badly, only do that when absolutely necessary.
            if (this.actor.mapped)
                this._redisplay(true);
        });

        this._redisplayFolderWorkId = Main.initializeDeferredWork(this._folderIcon.actor, () => { this._redisplay(); });
        let layoutChangedId = IconGridLayout.layout.connect('changed', () => {
            // AllView only checks for the toplevel icons, not those inside folders.
            Main.queueDeferredWork(this._redisplayFolderWorkId);
        });

        this._folderIcon.actor.connect('destroy', () => {
            // The deferred work will not be valid after the folderIcon is destroyed.
            IconGridLayout.layout.disconnect(layoutChangedId);
        });

        // Don't call _redisplay() here, since that will call reloadIcon() which, besides
        // not been needed at this point, will fail due to the view not being created yet.
        this._loadApps();
        this.updateNoAppsLabelVisibility();
    },

    _redisplay: function(forceRedisplay) {
        this.parent(forceRedisplay);
        this.updateNoAppsLabelVisibility();
        this._folderIcon.icon.reloadIcon();
    },

    _createItemIcon: function(item) {
        return new AppIcon(item,
                           { isDraggable: true,
                             parentView: this },
                           null);
    },

    updateNoAppsLabelVisibility: function() {
        this._noAppsLabel.visible = this._grid.visibleItemsCount() == 0;
    },

    _keyFocusIn: function(actor) {
        Util.ensureActorVisibleInScrollView(this.actor, actor);
    },

    createFolderIcon: function(size) {
        let layout = new Clutter.GridLayout();
        let icon = new St.Widget({ layout_manager: layout,
                                   style_class: 'app-folder-icon' });
        layout.hookup_style(icon);
        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);

        let numItems = this._allItems.length;
        let rtl = icon.get_text_direction() == Clutter.TextDirection.RTL;
        for (let i = 0; i < 4; i++) {
            let bin = new St.Bin({ width: subSize, height: subSize });
            if (i < numItems)
                bin.child = this._allItems[i].app.create_icon_texture(subSize);
            layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
        }

        return icon;
    },

    _onPan: function(action) {
        let [dist, dx, dy] = action.get_motion_delta(0);
        let adjustment = this.actor.vscroll.adjustment;
        adjustment.value -= (dy / this.actor.height) * adjustment.page_size;
        return false;
    },

    adaptToSize: function(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;

        this._grid.adaptToSize(width, height);

        // To avoid the fade effect being applied to the unscrolled grid,
        // the offset would need to be applied after adjusting the padding;
        // however the final padding is expected to be too small for the
        // effect to look good, so use the unadjusted padding
        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this.actor.update_fade_effect(fadeOffset, 0);

        // Set extra padding to avoid popup or close button being cut off
        this._grid.topPadding = Math.max(this._grid.topPadding - this._offsetForEachSide, 0);
        this._grid.bottomPadding = Math.max(this._grid.bottomPadding - this._offsetForEachSide, 0);
        this._grid.leftPadding = Math.max(this._grid.leftPadding - this._offsetForEachSide, 0);
        this._grid.rightPadding = Math.max(this._grid.rightPadding - this._offsetForEachSide, 0);

        this.actor.set_width(this.usedWidth());
        this.actor.set_height(this.usedHeight());
    },

    _getPageAvailableSize: function() {
        let pageBox = new Clutter.ActorBox();
        pageBox.x1 = pageBox.y1 = 0;
        pageBox.x2 = this._parentAvailableWidth;
        pageBox.y2 = this._parentAvailableHeight;

        let contentBox = this.actor.get_theme_node().get_content_box(pageBox);
        // We only can show icons inside the collection view boxPointer
        // so we have to substract the required padding etc of the boxpointer
        return [(contentBox.x2 - contentBox.x1) - 2 * this._offsetForEachSide, (contentBox.y2 - contentBox.y1) - 2 * this._offsetForEachSide];
    },

    usedWidth: function() {
        let [availWidthPerPage, availHeightPerPage] = this._getPageAvailableSize();
        return this._grid.usedWidth(availWidthPerPage);
    },

    usedHeight: function() {
        return this._grid.usedHeightForNRows(this.nRowsDisplayedAtOnce());
    },

    nRowsDisplayedAtOnce: function() {
        let [availWidthPerPage, availHeightPerPage] = this._getPageAvailableSize();
        let maxRows = this._grid.rowsForHeight(availHeightPerPage) - 1;
        return Math.min(this._grid.nRows(availWidthPerPage), maxRows);
    },

    setPaddingOffsets: function(offset) {
        this._offsetForEachSide = offset;
    },

    getViewId: function() {
        return this._folderIcon.getId();
    }
});

var ViewIconMenu = new Lang.Class({
    Name: 'ViewIconMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(source) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        this.parent(source.actor, 0.5, side);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        this._sourceMappedId = source.actor.connect('notify::mapped', () => {
            if (!source.actor.mapped)
                this.close();
        });
        source.actor.connect('destroy', () => {
            source.actor.disconnect(this._sourceMappedId);
            this.destroy();
        });

        Main.uiGroup.add_actor(this.actor);
    },

    redisplay: function() {
        this.removeAll();

        // First get a contextual submenu from the specific ViewIcon.
        let ctxtMenuSection = this._source.getContextualMenu();
        if (ctxtMenuSection && !ctxtMenuSection.isEmpty()) {
            this.addMenuItem(ctxtMenuSection);
            if (this._source.canBeRemoved())
                this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        if (this._source.canBeRemoved()) {
            // Add the "Remove from desktop" menu item at the end.
            let item = new PopupMenu.PopupMenuItem(_("Remove from desktop"));
            this.addMenuItem(item);
            item.connect('activate', Lang.bind(this, function() {
                this._source.remove();
            }));
        }
    },

    popup: function(activatingButton) {
        this.redisplay();
        this.open();
    }
});
Signals.addSignalMethods(ViewIconMenu.prototype);

const ViewIconState = {
    NORMAL: 0,
    DND_PLACEHOLDER: 1,
    NUM_STATES: 2
};

var ViewIcon = new Lang.Class({
    Name: 'ViewIcon',

    _init: function(params, buttonParams, iconParams) {
        params = Params.parse(params,
                              { isDraggable: true,
                                showMenu: true,
                                parentView: null },
                              true);
        buttonParams = Params.parse(buttonParams,
                                    { style_class: 'app-well-app',
                                      button_mask: St.ButtonMask.ONE |
                                                   St.ButtonMask.TWO |
                                                   St.ButtonMask.THREE,
                                      toggle_mode: false,
                                      can_focus: true,
                                      x_fill: true,
                                      y_fill: true
                                    },
                                    true);
        iconParams = Params.parse(iconParams,
                                  { editable: false,
                                    showLabel: true },
                                  true);

        this.showMenu = params.showMenu;
        this.parentView = params.parentView;

        this.canDrop = false;
        this.blockHandler = false;

        this._scaleInId = 0;

        // Might be changed once the createIcon() method is called.
        this._iconSize = IconGrid.ICON_SIZE;
        this._iconState = ViewIconState.NORMAL;

        this.actor = new St.Button(buttonParams);
        this.actor._delegate = this;
        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._createIconFunc = iconParams['createIcon'];
        iconParams['createIcon'] = Lang.bind(this, this._createIconBase);

        // Used to save the text when setting up the DnD placeholder.
        this._origText = null;

        this.icon = new IconGrid.BaseIcon(this.getName(), iconParams);
        if (iconParams['showLabel'] && iconParams['editable']) {
            this.icon.label.connect('label-edit-update', this._onLabelUpdate.bind(this));
            this.icon.label.connect('label-edit-cancel', this._onLabelCancel.bind(this));
        }

        this.actor.label_actor = this.icon.label;

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuTimeoutId = 0;

        this.actor.connect('leave-event', Lang.bind(this, this._onLeaveEvent));
        this.actor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        this.actor.connect('touch-event', Lang.bind(this, this._onTouchEvent));
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('popup-menu', Lang.bind(this, this._onKeyboardPopupMenu));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        if (params.isDraggable) {
            this._draggable = DND.makeDraggable(this.actor);
            this._draggable.connect('drag-begin', () => {
                this._removeMenuTimeout();
                Main.overview.beginItemDrag(this);
            });
            this._draggable.connect('drag-cancelled', () => {
                Main.overview.cancelledItemDrag(this);
            });
            this._draggable.connect('drag-end', () => {
                Main.overview.endItemDrag(this);
            });
        }
    },

    getId: function() {
        throw new Error('Not implemented');
    },

    getName: function() {
        throw new Error('Not implemented');
    },

    getIcon: function() {
        throw new Error('Not implemented');
    },

    _onLabelUpdate: function() {
        // Do nothing by default
    },

    _onLabelCancel: function() {
        this.icon.actor.sync_hover();
    },

    _onDestroy: function() {
        this._unscheduleScaleIn();

        this.actor._delegate = null;
        this._removeMenuTimeout();
    },

    activate: function (button) {
        throw new Error('Not implemented');
    },

    hasMenu: function() {
        return this.showMenu;
    },

    getContextualMenu: function() {
        // No contextual menu by default;
        return null;
    },

    canBeRemoved: function() {
        // Icons are removable by default
        return true;
    },

    popupMenu: function() {
        this._removeMenuTimeout();

        if (!this.hasMenu())
            return true;

        this.actor.fake_release();

        if (this._draggable)
            this._draggable.fakeRelease();

        if (!this._menu) {
            this._menu = new ViewIconMenu(this);
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            let id = Main.overview.connect('hiding', () => { this._menu.close(); });
            this.actor.connect('destroy', function() {
                Main.overview.disconnect(id);
            });

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.actor.set_hover(true);
        this._menu.popup();
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    },

    _onMenuPoppedDown: function() {
        this.actor.sync_hover();
        this.emit('menu-state-changed', false);
    },

    _onLeaveEvent: function(actor, event) {
        this.actor.fake_release();
        this._removeMenuTimeout();
    },

    _removeMenuTimeout: function() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    },

    _setPopupTimeout: function() {
        this._removeMenuTimeout();
        this._menuTimeoutId = Mainloop.timeout_add(MENU_POPUP_TIMEOUT, () => {
            this._menuTimeoutId = 0;
            this.popupMenu();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._menuTimeoutId, '[gnome-shell] this.popupMenu');
    },

    _onButtonPress: function(actor, event) {
        let button = event.get_button();
        if (button == Gdk.BUTTON_PRIMARY) {
            this._setPopupTimeout();
        } else if (button == Gdk.BUTTON_SECONDARY) {
            this.popupMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    },

    _onTouchEvent: function (actor, event) {
        if (event.type() == Clutter.EventType.TOUCH_BEGIN)
            this._setPopupTimeout();

        return Clutter.EVENT_PROPAGATE;
    },

    _onClicked: function(actor, button) {
        this._removeMenuTimeout();
        this.activate(button);
    },

    _onKeyboardPopupMenu: function() {
        this.popupMenu();
        this._menu.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
    },

    _createIconBase: function(iconSize) {
        if (this._iconSize != iconSize)
            this._iconSize = iconSize;

        // Replace the original icon with an empty placeholder
        if (this._iconState == ViewIconState.DND_PLACEHOLDER)
            return new St.Icon({ icon_size: this._iconSize });

        return this._createIconFunc(this._iconSize);
    },

    _scaleIn: function() {
        this.actor.scale_x = 0;
        this.actor.scale_y = 0;
        this.actor.pivot_point = new Clutter.Point({ x: 0.5, y: 0.5 });

        Tweener.addTween(this.actor, {
            scale_x: 1,
            scale_y: 1,
            time: EOS_NEW_ICON_ANIMATION_TIME,
            delay: EOS_NEW_ICON_ANIMATION_DELAY,
            transition: function(t, b, c, d) {
                // Similar to easeOutElastic, but less aggressive.
                t /= d;
                let p = 0.5;
                return b + c * (Math.pow(2, -11 * t) * Math.sin(2 * Math.PI * (t - p / 4) / p) + 1);
            }
        });
    },

    _unscheduleScaleIn: function() {
        if (this._scaleInId != 0) {
            Main.overview.disconnect(this._scaleInId);
            this._scaleInId = 0;
        }
    },

    scheduleScaleIn: function() {
        if (this._scaleInId != 0)
            return;

        if (Main.overview.visible) {
            this._scaleIn();
            return;
        }

        this._scaleInId = Main.overview.connect('shown', () => {
            this._unscheduleScaleIn();
            this._scaleIn();
        });
    },

    remove: function() {
        this.blockHandler = true;
        IconGridLayout.layout.removeIcon(this.getId(), true);
        this.blockHandler = false;

        this.handleViewDragEnd();
        this.actor.hide();
    },

    replaceText: function(newText) {
        if (!this.icon.label)
            return;

        this._origText = this.icon.label.text;
        this.icon.label.text = newText;
    },

    restoreText: function() {
        if (!this._origText)
            return;

        this.icon.label.text = this._origText;
        this._origText = null;
    },

    prepareDndPlaceholder: function() {
        this.replaceText('');
    },

    resetDnDPlaceholder: function() {
        this.restoreText();
    },

    handleViewDragBegin: function() {
        this.iconState = ViewIconState.DND_PLACEHOLDER;
        this.prepareDndPlaceholder();
    },

    handleViewDragEnd: function() {
        if (!this.blockHandler) {
            this.iconState = ViewIconState.NORMAL;
            this.resetDnDPlaceholder();
        }
    },

    setDragHoverState: function(state) {
        this.icon.actor.set_hover(state);
    },

    canDragOver: function(dest) {
        return false;
    },

    handleIconDrop: function(source) {
        throw new Error('Not implemented');
    },

    getDragActor: function() {
        let iconParams = { createIcon: Lang.bind(this, this._createIcon),
                           showLabel: (this.icon.label != null),
                           setSizeManually: false };

        let icon = new IconGrid.BaseIcon(this.getName(), iconParams);
        icon.actor.add_style_class_name('dnd');
        return icon.actor;
    },

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource: function() {
        return this.icon.icon;
    },

    set iconState(iconState) {
        if (this._iconState == iconState)
            return;

        this._iconState = iconState;
        this.icon.reloadIcon();
    },

    get iconState() {
        return this._iconState;
    }
});

var FolderIcon = new Lang.Class({
    Name: 'FolderIcon',
    Extends: ViewIcon,

    _init: function(dirInfo, parentView) {
        let viewIconParams = { isDraggable: true,
                               parentView: parentView };
        let buttonParams = { button_mask: St.ButtonMask.ONE,
                             toggle_mode: true };
        let iconParams = { createIcon: this._createIcon.bind(this),
                           setSizeManually: false,
                           editable: true };
        this.name = dirInfo.get_name();
        this._parentView = parentView;

        this.id = dirInfo.get_id();
        this._dirInfo = dirInfo;

        this.parent(viewIconParams, buttonParams, iconParams);
        this.actor.add_style_class_name('app-folder');

        this._iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                              x_expand: true, y_expand: true });
        this._iconContainer.add_child(this.icon.actor);

        this.actor.set_child(this._iconContainer);

        // whether we need to update arrow side, position etc.
        this._popupInvalidated = false;

        this.canDrop = true;

        this.view = new FolderView(this, this._dirInfo);

        this._updateName();

        this.actor.connect('notify::mapped', Lang.bind(this,
            function() {
                if (!this.actor.mapped && this._popup)
                    this._popup.popdown();
            }));
    },

    getId: function() {
        return this._dirInfo.get_id();
    },

    getName: function() {
        return this.name;
    },

    getIcon: function() {
        return this._dirInfo.get_icon();
    },

    getAppIds: function() {
        return this.view.getAllItems().map(function(item) {
            return item.id;
        });
    },

    activate: function (button) {
        this._ensurePopup();
        this.view.actor.vscroll.adjustment.value = 0;
        this._openSpaceForPopup();
    },

    hasMenu: function() {
        // A folder shows its menu only if it can be removed.
        return this.showMenu && this.canBeRemoved()
    },

    canBeRemoved: function() {
        // Only non-empty folders can be removed
        let appsInFolder = this.getAppIds();
        return appsInFolder.length == 0;
    },

    _onLabelUpdate: function(label, newText) {
        try {
            this._dirInfo.create_custom_with_name(newText);
            this.name = newText;
        } catch(e) {
            logError(e, 'error while creating a custom dirInfo for: '
                      + this.name
                      + ' using new name: '
                      + newText);
        }
    },

    _updateName: function() {
        let name = this._dirInfo.get_name();
        if (this.name == name)
            return;

        this.name = name;
        this.icon.label.text = this.name;
        this.emit('name-changed');
    },

    _createIcon: function(iconSize) {
        return this.view.createFolderIcon(iconSize, this);
    },

    _popupHeight: function() {
        let usedHeight = this.view.usedHeight() + this._popup.getOffset(St.Side.TOP) + this._popup.getOffset(St.Side.BOTTOM);
        return usedHeight;
    },

    _openSpaceForPopup: function() {
        let id = this._parentView.connect('space-ready', Lang.bind(this,
            function() {
                this._parentView.disconnect(id);
                this._popup.popup();
                this._updatePopupPosition();
            }));
        this._parentView.openSpaceForPopup(this, this._boxPointerArrowside,
                                           Math.max(this.view.nRowsDisplayedAtOnce(), 1));
    },

    _calculateBoxPointerArrowSide: function() {
        let spaceTop = this.actor.y - this._parentView.getCurrentPageY();
        let spaceBottom = this._parentView.actor.height - (spaceTop + this.actor.height);

        return spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;
    },

    _updatePopupSize: function() {
        // StWidget delays style calculation until needed, make sure we use the correct values
        this.view._grid.actor.ensure_style();

        let offsetForEachSide = Math.ceil((this._popup.getOffset(St.Side.TOP) +
                                           this._popup.getOffset(St.Side.BOTTOM) -
                                           this._popup.getCloseButtonOverlap()) / 2);
        // Add extra padding to prevent boxpointer decorations and close button being cut off
        this.view.setPaddingOffsets(offsetForEachSide);
        this.view.adaptToSize(this._parentAvailableWidth, this._parentAvailableHeight);
    },

    _updatePopupPosition: function() {
        if (!this._popup)
            return;

        if (this._boxPointerArrowside == St.Side.BOTTOM)
            this._popup.actor.y = this.actor.allocation.y1 + this.actor.translation_y - this._popupHeight();
        else
            this._popup.actor.y = this.actor.allocation.y1 + this.actor.translation_y + this.actor.height;
    },

    _ensurePopup: function() {
        if (this._popup && !this._popupInvalidated)
            return;
        this._boxPointerArrowside = this._calculateBoxPointerArrowSide();
        if (!this._popup) {
            this._popup = new AppFolderPopup(this, this._boxPointerArrowside);
            this._parentView.addFolderPopup(this._popup);
            this._popup.connect('open-state-changed', Lang.bind(this,
                function(popup, isOpen) {
                    if (!isOpen)
                        this.actor.checked = false;
                }));
        } else {
            this._popup.updateArrowSide(this._boxPointerArrowside);
        }
        this._updatePopupSize();
        this._updatePopupPosition();
        this._popupInvalidated = false;
    },

    adaptToSize: function(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;
        if(this._popup)
            this.view.adaptToSize(width, height);
        this._popupInvalidated = true;
    },

    canDragOver: function(dest) {
        // Can't drag folders over other folders
        if (dest.folder)
            return false;

        // Can't remove non-empty folders by throwing
        // them onto the bin from the App Center icon.
        if (dest.getId() == EOS_APP_CENTER_ID)
            return this.canBeRemoved();

        return true;
    },

    handleIconDrop: function(source) {
        // Move the source icon into this folder
        IconGridLayout.layout.appendIcon(source.getId(), this.getId());
        return true;
    },

    get folder() {
        return this._dirInfo;
    }
});
Signals.addSignalMethods(FolderIcon.prototype);

var AppFolderPopup = new Lang.Class({
    Name: 'AppFolderPopup',

    _init: function(source, side) {
        this._source = source;
        this._view = source.view;
        this._arrowSide = side;

        this._isOpen = false;
        this.parentOffset = 0;

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     visible: false,
                                     // We don't want to expand really, but look
                                     // at the layout manager of our parent...
                                     //
                                     // DOUBLE HACK: if you set one, you automatically
                                     // get the effect for the other direction too, so
                                     // we need to set the y_align
                                     x_expand: true,
                                     y_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.START });
        this._boxPointer = new BoxPointer.BoxPointer(this._arrowSide,
                                                     { style_class: 'app-folder-popup-bin',
                                                       x_fill: true,
                                                       y_fill: true,
                                                       x_expand: true,
                                                       x_align: St.Align.START });

        this._boxPointer.actor.style_class = 'app-folder-popup';
        this.actor.add_actor(this._boxPointer.actor);
        this._boxPointer.bin.set_child(this._view.actor);

        this.closeButton = Util.makeCloseButton(this._boxPointer);
        this.closeButton.connect('clicked', Lang.bind(this, this.popdown));
        this.actor.add_actor(this.closeButton);

        this._boxPointer.actor.bind_property('opacity', this.closeButton, 'opacity',
                                             GObject.BindingFlags.SYNC_CREATE);

        global.focus_manager.add_group(this.actor);

        source.actor.connect('destroy', Lang.bind(this,
            function() {
                this.actor.destroy();
            }));
        this._grabHelper = new GrabHelper.GrabHelper(this.actor);
        this._grabHelper.addActor(Main.layoutManager.overviewGroup);
        this.actor.connect('key-press-event', Lang.bind(this, this._onKeyPress));
    },

    _onKeyPress: function(actor, event) {
        if (global.stage.get_key_focus() != actor)
            return Clutter.EVENT_PROPAGATE;

        // Since we need to only grab focus on one item child when the user
        // actually press a key we don't use navigate_focus when opening
        // the popup.
        // Instead of that, grab the focus on the AppFolderPopup actor
        // and actually moves the focus to a child only when the user
        // actually press a key.
        // It should work with just grab_key_focus on the AppFolderPopup
        // actor, but since the arrow keys are not wrapping_around the focus
        // is not grabbed by a child when the widget that has the current focus
        // is the same that is requesting focus, so to make it works with arrow
        // keys we need to connect to the key-press-event and navigate_focus
        // when that happens using TAB_FORWARD or TAB_BACKWARD instead of arrow
        // keys

        // Use TAB_FORWARD for down key and right key
        // and TAB_BACKWARD for up key and left key on ltr
        // languages
        let direction;
        let isLtr = Clutter.get_default_text_direction() == Clutter.TextDirection.LTR;
        switch (event.get_key_symbol()) {
            case Clutter.Down:
                direction = Gtk.DirectionType.TAB_FORWARD;
                break;
            case Clutter.Right:
                direction = isLtr ? Gtk.DirectionType.TAB_FORWARD :
                                    Gtk.DirectionType.TAB_BACKWARD;
                break;
            case Clutter.Up:
                direction = Gtk.DirectionType.TAB_BACKWARD;
                break;
            case Clutter.Left:
                direction = isLtr ? Gtk.DirectionType.TAB_BACKWARD :
                                    Gtk.DirectionType.TAB_FORWARD;
                break;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
        return actor.navigate_focus(null, direction, false);
    },

    toggle: function() {
        if (this._isOpen)
            this.popdown();
        else
            this.popup();
    },

    popup: function() {
        if (this._isOpen)
            return;

        this._isOpen = this._grabHelper.grab({ actor: this.actor,
                                               onUngrab: Lang.bind(this, this.popdown) });

        if (!this._isOpen)
            return;

        this.actor.show();

        this._boxPointer.setArrowActor(this._source.actor);
        // We need to hide the icons of the view until the boxpointer animation
        // is completed so we can animate the icons after as we like without
        // showing them while boxpointer is animating.
        this._view.actor.opacity = 0;
        this._boxPointer.show(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE,
                              Lang.bind(this,
            function() {
                this._view.actor.opacity = 255;
                this._view.animate(IconGrid.AnimationDirection.IN);
            }));

        this.emit('open-state-changed', true);
    },

    popdown: function() {
        if (!this._isOpen)
            return;

        this._grabHelper.ungrab({ actor: this.actor });

        this._boxPointer.hide(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE);
        this._isOpen = false;
        this.emit('open-state-changed', false);
    },

    getCloseButtonOverlap: function() {
        return this.closeButton.get_theme_node().get_length('-shell-close-overlap-y');
    },

    getOffset: function (side) {
        let offset = this._boxPointer.getPadding(side);
        if (this._arrowSide == side)
            offset += this._boxPointer.getArrowHeight();
        return offset;
    },

    updateArrowSide: function (side) {
        this._arrowSide = side;
        this._boxPointer.updateArrowSide(side);
    }
});
Signals.addSignalMethods(AppFolderPopup.prototype);

var AppIconSourceActor = new Lang.Class({
    Name: 'AppIconSourceActor',
    Extends: MessageTray.SourceActor,

    _init: function(source, size) {
        this.parent(source, size);
        this.setIcon(new St.Bin());
    },

    _shouldShowCount: function() {
        // Always show the counter when there's at least one notification
        return this.source.count > 0;
    }
});

var AppIcon = new Lang.Class({
    Name: 'AppIcon',
    Extends: ViewIcon,

    _init : function(app, viewIconParams, iconParams) {
        this.app = app;
        this.id = app.get_id();
        this.name = app.get_name();
        this._sourceAddedId = 0;

        let buttonParams = { button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO };
        iconParams = Params.parse(iconParams, { createIcon: this._createIcon.bind(this),
                                                createExtraIcons: this._createExtraIcons.bind(this) },
                                  true);
        if (!iconParams)
            iconParams = {};

        this.parent(viewIconParams, buttonParams, iconParams);

        this._dot = new St.Widget({ style_class: 'app-well-app-running-dot',
                                    layout_manager: new Clutter.BinLayout(),
                                    x_expand: true, y_expand: true,
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.END });

        this._iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                              x_expand: true, y_expand: true });
        this._iconContainer.add_child(this.icon.actor);

        this.actor.set_child(this._iconContainer);
        this._iconContainer.add_child(this._dot);

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._stateChangedId = this.app.connect('notify::state', Lang.bind(this,
            function () {
                this._updateRunningStyle();
            }));
        this._updateRunningStyle();

        if (app.get_id() === 'com.endlessm.Coding.Chatbox.desktop')
            this._sourceAddedId = Main.messageTray.connect('source-added',
                                                           this._sourceAdded.bind(this));
    },

    getId: function() {
        return this.app.get_id();
    },

    getName: function() {
        return this.name;
    },

    getIcon: function() {
        return this.app.get_icon();
    },

    _onDestroy: function() {
        if (this._stateChangedId > 0)
            this.app.disconnect(this._stateChangedId);
        this._stateChangedId = 0;

        if (this._sourceAddedId > 0) {
            Main.messageTray.disconnect(this._sourceAddedId);
            this._sourceAddedId = 0;
        }
    },

    _createIcon: function(iconSize) {
        return this.app.create_icon_texture(iconSize);
    },

    _createExtraIcons: function(iconSize) {
        if (!this._notificationSource)
            return [];

        let sourceActor = new AppIconSourceActor(this._notificationSource, iconSize);
        return [sourceActor.actor];
    },

    _sourceAdded: function(tray, source) {
        // we are only interested in ChatBox notifications for now, early return
        // if not the type we are looking for
        if (!(source instanceof NotificationDaemon.GtkNotificationDaemonAppSource))
            return;

        if (source.app != this.app)
            return;

        this._notificationSource = source;
        this._notificationSource.connect('destroy', () => {
            this._notificationSource = null;
            this.icon.reloadIcon();
        });

        this.icon.reloadIcon();
    },

    _updateRunningStyle: function() {
        if (this.app.state != Shell.AppState.STOPPED)
            this._dot.show();
        else
            this._dot.hide();
    },

    animateLaunch: function() {
        this.icon.animateZoomOut();
    },

    shellWorkspaceLaunch : function(params) {
        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        this.app.open_new_window(params.workspace);
    },

    activateWindow: function(metaWindow) {
        if (metaWindow)
            Main.activateWindow(metaWindow);
        else
            Main.overview.hide();
    },

    activate: function (button) {
        let event = Clutter.get_current_event();
        let activationContext = new AppActivation.AppActivationContext(this.app);
        activationContext.activate(event);
    },

    getContextualMenu: function() {
        let menu = new PopupMenu.PopupMenuSection();

        let windows = this.app.get_windows().filter(function(w) {
            return !w.skip_taskbar;
        });

        // Display the app windows menu items and the separator between windows
        // of the current desktop and other windows.
        let activeWorkspace = global.screen.get_active_workspace();
        let separatorShown = windows.length > 0 && windows[0].get_workspace() != activeWorkspace;

        for (let i = 0; i < windows.length; i++) {
            let window = windows[i];
            if (!separatorShown && window.get_workspace() != activeWorkspace) {
                this._appendSeparator();
                separatorShown = true;
            }

            let item = new PopupMenu.PopupMenuItem(window.title);
            menu.addMenuItem(item);
            item.connect('activate', Lang.bind(this, function() {
                this.activateWindow(window);
            }));
        }

        if (this.app.is_window_backed())
            return menu;

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let appInfo = this.app.get_app_info();
        let actions = appInfo.list_actions();
        if (this.app.can_open_new_window() &&
            actions.indexOf('new-window') == -1) {

            this._newWindowMenuItem = new PopupMenu.PopupMenuItem(_("New Window"));
            menu.addMenuItem(this._newWindowMenuItem);

            this._newWindowMenuItem.connect('activate', () => {
                if (this.app.state == Shell.AppState.STOPPED)
                    this.animateLaunch();

                this.app.open_new_window(-1);
                this.activateWindow(null);
            });
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        if (discreteGpuAvailable &&
            this.app.state == Shell.AppState.STOPPED &&
            actions.indexOf('activate-discrete-gpu') == -1) {
            this._onDiscreteGpuMenuItem = this._appendMenuItem(_("Launch using Dedicated Graphics Card"));
            this._onDiscreteGpuMenuItem.connect('activate', () => {
                if (this.app.state == Shell.AppState.STOPPED)
                    this._source.animateLaunch();

                this.app.launch(0, -1, true);
                this.emit('activate-window', null);
            });
        }

        for (let i = 0; i < actions.length; i++) {
            let action = actions[i];
            let item = new PopupMenu.PopupMenuItem(appInfo.get_action_name(action));
            menu.addMenuItem(item);
            item.connect('activate', (emitter, event) => {
                this.app.launch_action(action, event.get_time(), -1);
                this.activateWindow(null);
            });
        }

        return menu;
    },

    prepareDndPlaceholder: function() {
        this.parent();
        this._dot.hide();
    },

    resetDnDPlaceholder: function() {
        this.parent();

        if (this.app.state != Shell.AppState.STOPPED)
            this._dot.show();
        else
            this._dot.hide();
    },

    canDragOver: function(dest) {
        return true;
    },

    shouldShowTooltip: function() {
        return this.actor.hover && (!this._menu || !this._menu.isOpen);
    }
});
Signals.addSignalMethods(AppIcon.prototype);

var SystemActionIcon = new Lang.Class({
    Name: 'SystemActionIcon',
    Extends: Search.GridSearchResult,

    activate: function() {
        SystemActions.getDefault().activateAction(this.metaInfo['id']);
        Main.overview.viewSelector.show(ViewSelector.ViewPage.APPS);
    }
});

const AppCenterIconState = {
    EMPTY_TRASH: ViewIconState.NUM_STATES,
    FULL_TRASH: ViewIconState.NUM_STATES + 1
};

var AppCenterIcon = new Lang.Class({
    Name: 'AppCenterIcon',
    Extends: AppIcon,

    _init : function(parentView) {
        let viewIconParams = { isDraggable: false,
                               showMenu: false,
                               parentView: parentView };

        let iconParams = { createIcon: this._createIcon.bind(this) };

        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app(EOS_APP_CENTER_ID);

        this.parent(app, viewIconParams, iconParams);

        this.canDrop = true;
    },

    _setStyleClass: function(state) {
        if (state == AppCenterIconState.EMPTY_TRASH) {
            this.actor.remove_style_class_name('trash-icon-full');
            this.actor.add_style_class_name('trash-icon-empty');
        } else if (state == AppCenterIconState.FULL_TRASH) {
            this.actor.remove_style_class_name('trash-icon-empty');
            this.actor.add_style_class_name('trash-icon-full');
        } else {
            this.actor.remove_style_class_name('trash-icon-empty');
            this.actor.remove_style_class_name('trash-icon-full');
        }
    },

    _createIcon: function(iconSize) {
        // Set the icon image as a background via CSS,
        // and return an empty icon to satisfy the caller
        this._setStyleClass(this.iconState);

        if (this.iconState != ViewIconState.NORMAL)
            return new St.Icon({ icon_size: iconSize });

        // In normal state we chain up to the parent to get the default icon.
        return this.parent(iconSize);
    },

    getId: function() {
        return EOS_APP_CENTER_ID;
    },

    getName: function() {
        return this.app.get_generic_name();
    },

    canBeRemoved: function() {
        return false;
    },

    handleViewDragBegin: function() {
        this.iconState = AppCenterIconState.EMPTY_TRASH;
        this.replaceText(_("Delete"));
    },

    setDragHoverState: function(state) {
        let appCenterIconState = state ?
            AppCenterIconState.FULL_TRASH : AppCenterIconState.EMPTY_TRASH;
        this.iconState = appCenterIconState;
    },

    handleIconDrop: function(source) {
        if (source.canBeRemoved())
            source.remove();

        this.handleViewDragEnd();
        return true;
    }
});
