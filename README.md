ampersand-model-optimistic-update-mixin
======================================

An ampersand-model and Backbone.Model compatible mixin combining smart defaults for efficient data updating (json+patch) and optimistic concurrency.

## What does it do?

It combines the optimistic concurrency over HTTP support of ampersand-optimistic-sync and the JSON PATCH (RFC6902) support of ampersand-model-patch-mixin.

This allows us to programmatically resolve conflicting edits, for example:

> Jill opens the contact editor for contact #1. When she did this, the server included an ETag header on her GET request to indicate what version of the contact data she had received. Jill makes her edits and clicks the save button. When the model's save logic sent the Ajax request to write the new data, it also sent the content of the original ETag header as an If-Match header.

> Unbeknownst to Jill, Fred had also begun editing the same contact and saved before she did. Because his save completed before hers, the version her request included was no longer valid. The server responded to Fred with a success status, but Jill's request returns a 412 - Pre-Condition Failed error, an updated ETag, and an updated copy of the server-side resource.

Then ampersand-optimistic-sync emits a `sync:invalid-version` event, that ampersand-model-optimistic-update-mixin has registered a handler for.  The handler compiles a detailed description of the data conflicts, if any, that have resulted and sets the new version. If the autoResolve config directive is set to a truthy value, the handler will also auto-resolve non-colliding changes, and if autoResolve is set to 'server' all colliding changes will be resolved in favor of the server's version.

If all differences were resolved a `sync:conflict-autoResolved` event is emitted with a data payload describing what operations were performed, including what data was overwritten and any data that remains unsaved.

If not, a `sync:conflict` event is emitted with a data payload including the same items as above, but also what conflicts remain unresolved.

The payload from either of the above events is also stored `_conflict` on the model.

## How do I use it?

```javascript

var optimisticUpdateMixin = require('ampersand-model-optimistic-update-mixin');
var Model = require('ampersand-model'); // OR require('backbone').Model;

module.exports = optimistiUpdateMixin(Model, {
    _optimisticUpdate: {/* configuration, if needed */}
});

```

The resulting constructor's extend method will intelligently preserve the configuration across multiple layers of inheritance, if needed.

## Configuration

- `optimistic: { /* ampersand-optimistic-sync configuration directives */ }`

- `patcher: { /* ampersand-model-patch-mixin configuration directives */ }`

- `autoResolve: true || 'server' || false // default behavior: false`

- `JSONPatch: true || false`
  default behavior: true, should updates be done using RFC6902 compliant json+patch requests?

- `debug: true || false`
  default behavior: false

- `ignoreProps: []`
  default: none, any properties listed here by name will be ignored when detecting conflicts between server (remote) and client (local) data.

- `collectionSort: {}`
  Sometimes server and client representations of collections don't agree as to model order. This directive allows us to re-order client-side collection data to accurately compare with server changes. Keys may be child collection names or default for a default sort order for all collections that don't have specified sort directive. The value for each key may be any valid sort directive to [underscore's sortBy method](http://underscorejs.org/#sortBy).

- `customCompare: { key: function (original, current) {} }`
  This allows you to override default diffing algorithm's when they are unable to accurately determine what changes are relevant, for instance, when the server-side is represented very differently client-side. The compare function should return true when the server and client versions should be considered equal, false if they should not, or an array of JSON patch operations to apply to original to make it equal to current.

## Methods

Methods from both ampersand-optimistic-sync and ampersand-model-patch-mixin are available, and one additional 'public' method is added:

- `reverseUnsaved: function (conflict) {}`
  This method may be directly subscribed to `sync:conflict` and `sync:conflict-autoResolved` events or wired up to user interactions to rollback unsaved client-side changes without re-initializing the model.
  