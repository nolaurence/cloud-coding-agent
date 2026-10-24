window.__ModuleLoader__.load({ id: "@cca/dsh-client-ui-brand", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/brand/src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// plugins/brand/src/client/Brand.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function CcaBrandMark({ size = 24 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "img",
    {
      src: "kloud-logo.svg",
      width: size,
      height: size,
      alt: "",
      "aria-hidden": "true",
      style: { display: "block" }
    }
  );
}
function CcaBrandName() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontWeight: 600, letterSpacing: "-0.01em" }, children: "Kloud Work" });
}

// plugins/brand/src/client/index.tsx
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
    yield ctx.slots.register({ name: "sidebar.brand.mark" }, CcaBrandMark);
    yield ctx.slots.register({ name: "sidebar.brand.name" }, CcaBrandName);
  }));
}
return module.exports;
} });
//# sourceMappingURL=client.js.map
