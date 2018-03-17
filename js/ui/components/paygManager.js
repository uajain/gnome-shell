// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright (C) 2018 Endless Mobile, Inc.
//
// This is a GNOME Shell component to wrap the interactions over
// D-Bus with the eos-payg system daemon.
//
// Licensed under the GNU General Public License Version 2
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

const { Gio, GLib, GObject } = imports.gi;

const Main = imports.ui.main;
const Signals = imports.signals;

const EOS_PAYG_NAME = 'com.endlessm.Payg1';
const EOS_PAYG_PATH = '/com/endlessm/Payg1';

const EOS_PAYG_IFACE = '<node> \
<interface name="com.endlessm.Payg1"> \
<method name="AddCode"> \
  <arg type="s" direction="in" name="code"/> \
</method> \
<method name="ClearCode" /> \
<signal name="Expired" /> \
<property name="ExpiryTime" type="t" access="read"/> \
<property name="Enabled" type="b" access="read"/> \
</interface> \
</node>';

var PaygManager = GObject.registerClass({
    Signals: { 'code-expired': { },
               'enabled-changed': { param_types: [GObject.TYPE_BOOLEAN] },
               'expiry-time-changed': { param_types: [GObject.TYPE_INT64] } },
}, class PaygManager extends GObject.Object {

    _init() {
        super._init();

        this._proxy = null;
        this._proxyInfo = Gio.DBusInterfaceInfo.new_for_xml(EOS_PAYG_IFACE);

        this._enabled = false;
        this._expiryTime = 0;

        this._codeExpiredId = 0;
        this._propertiesChangedId = 0;
    }

    _onPropertiesChanged(proxy, changedProps, invalidatedProps) {
        let propsDict = changedProps.deep_unpack();
        if (propsDict.hasOwnProperty('Enabled'))
            this._setEnabled(this._proxy.Enabled);

        if (propsDict.hasOwnProperty('ExpiryTime'))
            this._setExpiryTime(this._proxy.ExpiryTime);
    }

    _setEnabled(value) {
        if (this._enabled === value)
            return;

        this._enabled = value;
        this.emit('enabled-changed', this._enabled);
    }

    _setExpiryTime(value) {
        if (this._expiryTime === value)
            return;

        this._expiryTime = value;
        this.emit('expiry-time-changed', this._expiryTime);
    }

    _onCodeExpired(proxy) {
        this.emit('code-expired');
    }

    _onProxyConstructed(object, res) {
        try {
            object.init_finish (res);
        } catch (e) {
            logError(e, "Error while constructing D-Bus proxy for " + EOS_PAYG_NAME);
            return;
        }

        this._setEnabled(this._proxy.Enabled);
        this._setExpiryTime(this._proxy.ExpiryTime);
    }

    enable() {
        if (!this._proxy) {
            this._proxy = new Gio.DBusProxy({ g_connection: Gio.DBus.system,
                                              g_interface_name: this._proxyInfo.name,
                                              g_interface_info: this._proxyInfo,
                                              g_name: EOS_PAYG_NAME,
                                              g_object_path: EOS_PAYG_PATH,
                                              g_flags: Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION })

            this._proxy.init_async(GLib.PRIORITY_DEFAULT, null, this._onProxyConstructed.bind(this));
        }

        this._propertiesChangedId = this._proxy.connect('g-properties-changed', this._onPropertiesChanged.bind(this));
        this._codeExpiredId = this._proxy.connectSignal('Expired', this._onCodeExpired.bind(this));

        Main.paygManager = this;
    }

    disable() {
        Main.paygManager = null;

        if (this._propertiesChangedId > 0) {
            this._proxy.disconnect(this._propertiesChangedId);
            this._propertiesChangedId = 0;
        }

        if (this._codeExpiredId > 0) {
            this._proxy.disconnectSignal(this._codeExpiredId);
            this._codeExpiredId = 0;
        }

        this._setEnabled(false);
        this._setExpiryTime(0);
    }

    addCode(code) {
        this._proxy.AddCodeRemote(code);
    }

    clearCode() {
        this._proxy.ClearCodeRemote();
    }

    get enabled() {
        return this._enabled;
    }

    get expiryTime() {
        return this._expiryTime;
    }
});

var Component = PaygManager;
