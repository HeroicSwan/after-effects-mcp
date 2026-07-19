/**
 * ae-mcp full method dispatch (ES3). Loaded by engine on CONNECT.
 * Sets $.global.__AE_MCP_DISPATCH__(method, args, code)
 */
(function () {
  function findCompByName(name) {
    if (!app.project) return null;
    for (var i = 1; i <= app.project.numItems; i++) {
      var item = app.project.item(i);
      if (item instanceof CompItem && item.name === name) return item;
    }
    return null;
  }

  function resolveComp(args) {
    args = args || {};
    if (args.comp_index !== undefined && args.comp_index !== null) {
      var idx = Number(args.comp_index);
      var item = app.project.item(idx);
      if (item instanceof CompItem) return item;
      throw { code: "COMP_NOT_FOUND", message: "No composition at index " + idx };
    }
    if (args.comp_name) {
      var c = findCompByName(String(args.comp_name));
      if (c) return c;
      throw { code: "COMP_NOT_FOUND", message: 'Composition not found: "' + args.comp_name + '"' };
    }
    var active = app.project.activeItem;
    if (active && active instanceof CompItem) return active;
    throw { code: "NO_ACTIVE_COMP", message: "No active composition. Pass comp_name." };
  }

  function resolveLayer(comp, args) {
    args = args || {};
    if (args.layer_index !== undefined && args.layer_index !== null) {
      return comp.layer(Number(args.layer_index));
    }
    if (args.layer_name) {
      var matches = [];
      for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === args.layer_name) matches.push(comp.layer(i));
      }
      if (matches.length === 0) {
        throw { code: "LAYER_NOT_FOUND", message: 'Layer not found: "' + args.layer_name + '"' };
      }
      if (matches.length > 1) {
        throw { code: "LAYER_AMBIGUOUS", message: "Multiple layers named " + args.layer_name };
      }
      return matches[0];
    }
    throw { code: "LAYER_REQUIRED", message: "Pass layer_name or layer_index." };
  }

  function colorToRgb(arr) {
    if (!arr || !(arr instanceof Array) || arr.length < 3) return [1, 1, 1];
    return [Number(arr[0]), Number(arr[1]), Number(arr[2])];
  }

  function layerSummary(layer, detailed) {
    var o = {
      index: layer.index,
      name: layer.name,
      enabled: layer.enabled,
      inPoint: layer.inPoint,
      outPoint: layer.outPoint,
      startTime: layer.startTime,
      nullLayer: layer.nullLayer,
      threeDLayer: layer.threeDLayer
    };
    try {
      o.parent = layer.parent ? layer.parent.name : null;
    } catch (e) {
      o.parent = null;
    }
    if (detailed) {
      try {
        o.position = layer.property("ADBE Transform Group").property("ADBE Position").value;
        o.scale = layer.property("ADBE Transform Group").property("ADBE Scale").value;
        o.rotation = layer.property("ADBE Transform Group").property("ADBE Rotate Z").value;
        o.opacity = layer.property("ADBE Transform Group").property("ADBE Opacity").value;
      } catch (e2) {}
      o.effects = [];
      try {
        var eg = layer.property("ADBE Effect Parade");
        if (eg) {
          for (var i = 1; i <= eg.numProperties; i++) {
            var fx = eg.property(i);
            o.effects.push({
              index: i,
              name: fx.name,
              matchName: fx.matchName,
              enabled: fx.enabled
            });
          }
        }
      } catch (e3) {}
    }
    return o;
  }

  function compSummary(comp, detailed) {
    var o = {
      name: comp.name,
      id: comp.id,
      width: comp.width,
      height: comp.height,
      frameRate: comp.frameRate,
      duration: comp.duration,
      numLayers: comp.numLayers,
      bgColor: comp.bgColor
    };
    if (detailed) {
      o.layers = [];
      var limit = Math.min(comp.numLayers, 100);
      for (var i = 1; i <= limit; i++) o.layers.push(layerSummary(comp.layer(i), false));
    }
    return o;
  }

  function applyLayerProps(layer, args) {
    var tg = layer.property("ADBE Transform Group");
    if (args.position) tg.property("ADBE Position").setValue(args.position);
    if (args.scale) tg.property("ADBE Scale").setValue(args.scale);
    if (args.rotation !== undefined && args.rotation !== null) {
      try {
        tg.property("ADBE Rotate Z").setValue(Number(args.rotation));
      } catch (e) {}
    }
    if (args.opacity !== undefined && args.opacity !== null) {
      tg.property("ADBE Opacity").setValue(Number(args.opacity));
    }
    if (args.inPoint !== undefined && args.inPoint !== null) layer.inPoint = Number(args.inPoint);
    if (args.outPoint !== undefined && args.outPoint !== null) layer.outPoint = Number(args.outPoint);
    if (args.startTime !== undefined && args.startTime !== null) layer.startTime = Number(args.startTime);
    if (args.enabled !== undefined && args.enabled !== null) layer.enabled = !!args.enabled;
    if (args.threeDLayer !== undefined && args.threeDLayer !== null) layer.threeDLayer = !!args.threeDLayer;
    if (args.name) layer.name = String(args.name);
    if (args.parent_name) {
      var comp = layer.containingComp;
      for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === args.parent_name && comp.layer(i).index !== layer.index) {
          layer.parent = comp.layer(i);
          break;
        }
      }
    }
  }

  function resolveProperty(layer, propertyPath) {
    if (!propertyPath) throw { code: "PROP_REQUIRED", message: "property path required" };
    var parts = String(propertyPath).split("/");
    var prop = layer;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "Transform") part = "ADBE Transform Group";
      if (part === "Position") part = "ADBE Position";
      if (part === "Scale") part = "ADBE Scale";
      if (part === "Rotation") part = "ADBE Rotate Z";
      if (part === "Opacity") part = "ADBE Opacity";
      if (part === "Anchor Point") part = "ADBE Anchor Point";
      prop = prop.property(part);
      if (!prop) throw { code: "PROP_NOT_FOUND", message: "Property not found: " + propertyPath };
    }
    return prop;
  }

  function homeDir() {
    try {
      var u = $.getenv("USERPROFILE");
      if (u) return u;
    } catch (e) {}
    return Folder("~").fsName;
  }

  function makeTemplateText(comp, text, name, x, y, size, color, inPoint, outPoint, font) {
    var l = comp.layers.addText(String(text || ""));
    l.name = name;
    var td = l.property("ADBE Text Properties").property("ADBE Text Document").value;
    td.resetCharStyle();
    td.fontSize = Number(size || 64);
    td.fillColor = colorToRgb(color || [1, 1, 1]);
    td.applyFill = true;
    td.applyStroke = false;
    try { td.font = String(font || "Arial Bold"); } catch (e) {}
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    td.text = String(text || "");
    l.property("ADBE Text Properties").property("ADBE Text Document").setValue(td);
    l.property("ADBE Transform Group").property("ADBE Position").setValue([Number(x), Number(y)]);
    l.inPoint = Number(inPoint || 0);
    l.outPoint = Number(outPoint || comp.duration);
    return l;
  }

  function makeTemplateSolid(comp, name, color, width, height, x, y, inPoint, outPoint) {
    var l = comp.layers.addSolid(colorToRgb(color || [0, 0, 0]), name, Math.round(width), Math.round(height), 1, comp.duration);
    l.property("ADBE Transform Group").property("ADBE Position").setValue([Number(x), Number(y)]);
    l.inPoint = Number(inPoint || 0);
    l.outPoint = Number(outPoint || comp.duration);
    return l;
  }

  function makeShapeRect(comp, name, color, width, height, x, y, inPoint, outPoint, roundness, rotation) {
    var l = comp.layers.addShape();
    l.name = name;
    var contents = l.property("ADBE Root Vectors Group");
    var rect = contents.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([Number(width), Number(height)]);
    rect.property("ADBE Vector Rect Roundness").setValue(Number(roundness || 0));
    var fill = contents.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").setValue(colorToRgb(color));
    fill.property("ADBE Vector Fill Opacity").setValue(100);
    l.property("ADBE Transform Group").property("ADBE Position").setValue([Number(x), Number(y)]);
    if (rotation !== undefined) l.property("ADBE Transform Group").property("ADBE Rotate Z").setValue(Number(rotation));
    l.inPoint = Number(inPoint || 0);
    l.outPoint = Number(outPoint || comp.duration);
    return l;
  }

  function makeShapeCircle(comp, name, color, size, x, y, inPoint, outPoint, strokeColor, strokeWidth) {
    var l = comp.layers.addShape();
    l.name = name;
    var contents = l.property("ADBE Root Vectors Group");
    var ellipse = contents.addProperty("ADBE Vector Shape - Ellipse");
    ellipse.property("ADBE Vector Ellipse Size").setValue([Number(size), Number(size)]);
    if (strokeColor) {
      var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
      stroke.property("ADBE Vector Stroke Color").setValue(colorToRgb(strokeColor));
      stroke.property("ADBE Vector Stroke Width").setValue(Number(strokeWidth || 8));
      stroke.property("ADBE Vector Stroke Opacity").setValue(100);
    } else {
      var fill = contents.addProperty("ADBE Vector Graphic - Fill");
      fill.property("ADBE Vector Fill Color").setValue(colorToRgb(color));
      fill.property("ADBE Vector Fill Opacity").setValue(100);
    }
    l.property("ADBE Transform Group").property("ADBE Position").setValue([Number(x), Number(y)]);
    l.inPoint = Number(inPoint || 0);
    l.outPoint = Number(outPoint || comp.duration);
    return l;
  }

  function sceneLayout(comp, purpose, safeMargin) {
    var inset = Math.max(Number(safeMargin || 100), Math.round(Math.min(comp.width, comp.height) * 0.07));
    var left = inset;
    var right = comp.width - inset;
    var top = inset;
    var bottom = comp.height - inset;
    var centerX = comp.width / 2;
    var centerY = comp.height / 2;
    var layout = {
      left: left,
      right: right,
      top: top,
      bottom: bottom,
      centerX: centerX,
      centerY: centerY,
      headlineX: centerX,
      headlineY: centerY,
      supportX: centerX,
      supportY: centerY + comp.height * 0.16,
      labelX: left,
      labelY: top + comp.height * 0.035,
      accentX: right - comp.width * 0.08,
      accentY: top + comp.height * 0.12,
      lowerY: bottom - comp.height * 0.04
    };
    if (purpose === "setup") {
      layout.headlineY = centerY - comp.height * 0.02;
      layout.lowerY = bottom - comp.height * 0.02;
    } else if (purpose === "explanation") {
      layout.headlineY = centerY - comp.height * 0.04;
      layout.supportY = centerY + comp.height * 0.14;
    } else if (purpose === "payoff") {
      layout.headlineX = comp.width * 0.36;
      layout.headlineY = centerY;
      layout.accentX = right - comp.width * 0.16;
      layout.accentY = centerY;
    } else if (purpose === "cta") {
      layout.headlineY = top + comp.height * 0.24;
      layout.supportY = centerY + comp.height * 0.22;
      layout.lowerY = bottom - comp.height * 0.06;
    }
    return layout;
  }

  function boundedPoint(point, comp, safeMargin) {
    var inset = Math.max(Number(safeMargin || 100), Math.round(Math.min(comp.width, comp.height) * 0.045));
    return [
      Math.max(inset, Math.min(comp.width - inset, Number(point[0]))),
      Math.max(inset, Math.min(comp.height - inset, Number(point[1])))
    ];
  }

  function makeJapaneseDecor(comp, prefix, purpose, primary, accent, white, start, end, font, safeMargin) {
    var made = [];
    var w = comp.width;
    var h = comp.height;
    var layout = sceneLayout(comp, purpose, safeMargin);
    var dark = primary;
    var pink = accent;
    if (purpose === "hook") {
      made.push(makeShapeCircle(comp, prefix + "JP Pop Sun", pink, h * 0.24, layout.left + w * 0.045, layout.top + h * 0.07, start, end));
      made.push(makeShapeCircle(comp, prefix + "JP Pop Ring", null, h * 0.34, layout.right - h * 0.17, layout.bottom - h * 0.18, start, end, white, 10));
      made.push(makeShapeRect(comp, prefix + "JP Speed Line A", white, w * 0.18, 14, layout.right - w * 0.08, layout.top + h * 0.07, start, end, 7, -18));
      made.push(makeShapeRect(comp, prefix + "JP Speed Line B", pink, w * 0.12, 10, layout.right - w * 0.02, layout.top + h * 0.14, start, end, 5, -18));
      made.push(makeTemplateText(comp, "POP / 01", prefix + "JP Label", layout.labelX + w * 0.02, layout.labelY, 28, white, start, end, font));
    } else if (purpose === "setup") {
      var i;
      for (i = 0; i < 7; i++) made.push(makeShapeRect(comp, prefix + "JP Rhythm Bar " + i, i % 2 ? white : pink, 22, h * (0.12 + i * 0.018), layout.left + w * (0.045 + i * 0.045), layout.lowerY, start, end, 11, -8));
      made.push(makeShapeCircle(comp, prefix + "JP Rhythm Dot", pink, 46, layout.right - w * 0.035, layout.top + h * 0.08, start, end));
      made.push(makeTemplateText(comp, "RHYTHM / 02", prefix + "JP Label", layout.labelX + w * 0.02, layout.labelY, 28, white, start, end, font));
    } else if (purpose === "explanation") {
      made.push(makeShapeRect(comp, prefix + "JP Data Rail", white, w * 0.22, 12, layout.left + w * 0.11, layout.lowerY, start, end, 6, 0));
      made.push(makeShapeRect(comp, prefix + "JP Data Rail Accent", pink, w * 0.12, 12, layout.right - w * 0.11, layout.lowerY, start, end, 6, 0));
      made.push(makeShapeCircle(comp, prefix + "JP Data Dot A", pink, 34, layout.left + w * 0.02, layout.top + h * 0.09, start, end));
      made.push(makeShapeCircle(comp, prefix + "JP Data Dot B", white, 22, layout.right - w * 0.02, layout.top + h * 0.18, start, end));
      made.push(makeTemplateText(comp, "CATCH / 03", prefix + "JP Label", layout.labelX + w * 0.02, layout.labelY, 28, white, start, end, font));
    } else if (purpose === "payoff") {
      made.push(makeShapeCircle(comp, prefix + "JP Payoff Ring", null, h * 0.38, layout.accentX, layout.accentY, start, end, pink, 12));
      made.push(makeShapeRect(comp, prefix + "JP Payoff Corner A", white, 90, 18, layout.left + w * 0.04, layout.top + h * 0.09, start, end, 9, 35));
      made.push(makeShapeRect(comp, prefix + "JP Payoff Corner B", pink, 90, 18, layout.right - w * 0.04, layout.bottom - h * 0.09, start, end, 9, 35));
      made.push(makeShapeCircle(comp, prefix + "JP Payoff Dot A", white, 30, layout.left + w * 0.06, layout.bottom - h * 0.08, start, end));
      made.push(makeShapeCircle(comp, prefix + "JP Payoff Dot B", pink, 42, layout.right - w * 0.06, layout.top + h * 0.08, start, end));
      made.push(makeTemplateText(comp, "SUKI / 04", prefix + "JP Label", layout.labelX + w * 0.02, layout.labelY, 28, white, start, end, font));
    } else if (purpose === "cta") {
      made.push(makeShapeRect(comp, prefix + "JP CTA Button", pink, w * 0.32, 92, layout.centerX, layout.lowerY, start, end, 46, 0));
      made.push(makeShapeCircle(comp, prefix + "JP CTA Orb", white, 150, layout.left + w * 0.06, layout.lowerY - h * 0.09, start, end));
      made.push(makeShapeRect(comp, prefix + "JP CTA Spark A", pink, 90, 14, layout.right - w * 0.08, layout.top + h * 0.11, start, end, 7, 45));
      made.push(makeShapeRect(comp, prefix + "JP CTA Spark B", white, 90, 14, layout.right - w * 0.08, layout.top + h * 0.11, start, end, 7, -45));
      made.push(makeTemplateText(comp, "MATA NE / 05", prefix + "JP Label", layout.labelX + w * 0.02, layout.labelY, 28, pink, start, end, font));
    }
    return made;
  }

  function fadeLayer(layer, start, end, duration) {
    try {
      var op = layer.property("ADBE Transform Group").property("ADBE Opacity");
      var d = Number(duration || 0.25);
      if (d <= 0) { op.setValueAtTime(start, 100); return; }
      op.setValueAtTime(start, 0);
      op.setValueAtTime(Math.min(end, start + d), 100);
      op.setValueAtTime(Math.max(start + d, end - d), 100);
      if (!arguments[4]) op.setValueAtTime(end, 0);
    } catch (e) {}
  }

  function applyMotionEntrance(layer, start, transition, duration, comp) {
    try {
      var d = Number(duration || 0.25);
      var transform = layer.property("ADBE Transform Group");
      if (transition === "slide") {
        var position = transform.property("ADBE Position");
        var target = position.value;
        position.setValueAtTime(start, [target[0] - comp.width * 0.08, target[1]]);
        position.setValueAtTime(Math.min(layer.outPoint, start + d), target);
      } else if (transition === "scale") {
        var scale = transform.property("ADBE Scale");
        var scaleTarget = scale.value;
        scale.setValueAtTime(start, [scaleTarget[0] * 0.82, scaleTarget[1] * 0.82]);
        scale.setValueAtTime(Math.min(layer.outPoint, start + d), scaleTarget);
      }
    } catch (e) {}
  }

  function mographKey(property, time, value) {
    try {
      property.setValueAtTime(Number(time), value);
      var keyIndex = property.nearestKeyIndex(Number(time));
      try {
        property.setInterpolationTypeAtKey(keyIndex, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      } catch (e1) {}
    } catch (e) {}
  }

  function enableMographMotion(comp, layer) {
    try { comp.motionBlur = true; } catch (e) {}
    try { comp.shutterAngle = 180; } catch (e2) {}
    try { comp.shutterPhase = -90; } catch (e3) {}
    try { layer.motionBlur = true; } catch (e4) {}
  }

  function animateMographLayer(layer, start, end, transition, order, purpose, comp, energy, safeMargin) {
    try {
      var name = String(layer.name);
      var span = Math.max(0.75, end - start);
      var reveal = Math.min(0.42, Math.max(0.16, span * 0.12));
      var impact = start + reveal * (0.38 + Math.min(0.24, order * 0.035));
      var settle = start + reveal;
      var accent = start + span * (0.48 + Math.min(0.1, order * 0.01));
      var transform = layer.property("ADBE Transform Group");
      var opacity = transform.property("ADBE Opacity");
      var position = transform.property("ADBE Position");
      var scale = transform.property("ADBE Scale");
      var rotation = transform.property("ADBE Rotate Z");
      var targetPosition = position.value;
      var targetScale = scale.value;
      var targetRotation = rotation.value;
      var fullFrame = name.indexOf("Hook Accent") !== -1 || name.indexOf("Chapter Accent") !== -1 || name.indexOf("End Screen Background") !== -1 || name.indexOf("Quote Background") !== -1;
      enableMographMotion(comp, layer);
      mographKey(opacity, start, 100);
      if (fullFrame) return;
      var textLayer = name.indexOf("MOGRAPH:") !== -1 || name.indexOf("JP Label") !== -1;
      var distanceX = comp.width * (textLayer ? 0.026 : 0.016) * (0.8 + energy * 0.35);
      var distanceY = comp.height * (textLayer ? 0.024 : 0.014) * (0.8 + energy * 0.35);
      var enterSign = purpose === "setup" ? 1 : purpose === "payoff" ? -1 : 0;
      var offsetX = purpose === "payoff" ? -distanceX : purpose === "setup" ? distanceX : 0;
      var offsetY = purpose === "cta" ? distanceY : enterSign * distanceY;
      var boundedTarget = boundedPoint(targetPosition, comp, safeMargin);
      var boundedStart = boundedPoint([boundedTarget[0] + offsetX, boundedTarget[1] + offsetY], comp, safeMargin);
      var boundedImpact = boundedPoint([boundedTarget[0] - offsetX * 0.18, boundedTarget[1] - offsetY * 0.18], comp, safeMargin);
      if (name.indexOf("Transition Sweep") !== -1) {
        mographKey(position, start, [-comp.width * 0.12, targetPosition[1]]);
        mographKey(position, settle, [comp.width * 1.12, targetPosition[1]]);
        return;
      }
      if (name.indexOf("Speed") !== -1 || name.indexOf("Spark") !== -1) {
        mographKey(position, start, boundedStart);
        mographKey(position, impact, boundedTarget);
        mographKey(position, accent, boundedImpact);
        mographKey(position, settle, boundedTarget);
        mographKey(rotation, start, targetRotation - 12);
        mographKey(rotation, impact, targetRotation + 5);
        mographKey(rotation, settle, targetRotation);
      } else if (name.indexOf("Rhythm") !== -1 || name.indexOf("Rail") !== -1) {
        mographKey(scale, start, [35, targetScale[1], targetScale[2]]);
        mographKey(scale, impact, [115, targetScale[1], targetScale[2]]);
        mographKey(scale, settle, targetScale);
        mographKey(scale, accent, [targetScale[0] * 0.78, targetScale[1], targetScale[2]]);
        mographKey(scale, settle + Math.min(0.22, span * 0.08), targetScale);
      } else if (name.indexOf("Ring") !== -1 || name.indexOf("Orb") !== -1 || name.indexOf("Sun") !== -1 || name.indexOf("Dot") !== -1) {
        mographKey(scale, start, [25, 25, targetScale[2]]);
        mographKey(scale, impact, [125, 125, targetScale[2]]);
        mographKey(scale, settle, targetScale);
        mographKey(position, start, boundedStart);
        mographKey(position, settle, boundedTarget);
        mographKey(scale, accent, [targetScale[0] * 1.12, targetScale[1] * 1.12, targetScale[2]]);
        mographKey(scale, settle + Math.min(0.2, span * 0.06), targetScale);
      } else {
        mographKey(position, start, boundedStart);
        mographKey(position, impact, boundedImpact);
        mographKey(position, settle, boundedTarget);
        mographKey(scale, start, [targetScale[0] * 0.84, targetScale[1] * 0.84, targetScale[2]]);
        mographKey(scale, impact, [targetScale[0] * 1.08, targetScale[1] * 1.08, targetScale[2]]);
        mographKey(scale, settle, targetScale);
        mographKey(rotation, start, targetRotation - (order % 2 ? 4 : -4));
        mographKey(rotation, impact, targetRotation + (order % 2 ? 2 : -2));
        mographKey(rotation, settle, targetRotation);
      }
      if (purpose === "hook" || purpose === "payoff") {
        mographKey(rotation, accent, targetRotation + (order % 2 ? 3 : -3));
        mographKey(rotation, Math.min(end - 0.05, accent + 0.18), targetRotation);
      }
    } catch (e) {}
  }

  function createMotionTemplate(args) {
    var comp = resolveComp(args);
    var id = String(args.template_id || "lower-third");
    var text = String(args.text || args.title || "Your Title");
    var subtitle = String(args.subtitle || "");
    var primary = colorToRgb(args.primary_color || [0.08, 0.08, 0.1]);
    var accent = colorToRgb(args.accent_color || [0.2, 0.65, 1]);
    var white = colorToRgb(args.text_color || [1, 1, 1]);
    var font = args.font_family || "Arial Bold";
    var safeMargin = Number(args.safe_margin || 100);
    var layout = sceneLayout(comp, String(args.scene_purpose || ""), safeMargin);
    var prefix = args.scene_id ? String(args.scene_id) + " | " : "";
    var start = Number(args.start || 0);
    var end = Number(args.end || comp.duration);
    var made = [];
    var style = String(args.visual_style || "");
    if (id === "lower-third") {
      made.push(makeTemplateSolid(comp, prefix + "MOGRAPH: Lower Third Bar", accent, comp.width * 0.62, comp.height * 0.12, comp.width * 0.36, comp.height * 0.78, start, end));
      made.push(makeTemplateText(comp, text, prefix + "MOGRAPH: Lower Third Title", comp.width * 0.38, comp.height * 0.75, Number(args.font_size || 54), white, start, end, font));
      if (subtitle) made.push(makeTemplateText(comp, subtitle, prefix + "MOGRAPH: Lower Third Subtitle", comp.width * 0.38, comp.height * 0.82, Number(args.subtitle_size || 28), white, start, end, font));
    } else if (id === "chapter-card") {
      made.push(makeTemplateSolid(comp, prefix + "MOGRAPH: Chapter Accent", accent, comp.width, comp.height, comp.width / 2, comp.height / 2, start, end));
      made.push(makeTemplateText(comp, text, prefix + "MOGRAPH: Chapter Title", comp.width / 2, comp.height / 2, Number(args.font_size || 92), white, start, end, font));
    } else if (id === "stat-callout") {
      made.push(makeTemplateText(comp, text, prefix + "MOGRAPH: Statistic", comp.width / 2, comp.height * 0.46, Number(args.font_size || 160), accent, start, end, font));
      if (subtitle) made.push(makeTemplateText(comp, subtitle, prefix + "MOGRAPH: Statistic Label", comp.width / 2, comp.height * 0.62, Number(args.subtitle_size || 42), white, start, end, font));
    } else if (id === "quote-card") {
      made.push(makeTemplateSolid(comp, prefix + "MOGRAPH: Quote Background", primary, comp.width * 0.84, comp.height * 0.48, comp.width / 2, comp.height / 2, start, end));
      made.push(makeTemplateText(comp, text, prefix + "MOGRAPH: Quote", layout.headlineX, layout.headlineY, Number(args.font_size || 58), white, start, end, font));
    } else if (id === "subscribe") {
      made.push(makeTemplateSolid(comp, prefix + "MOGRAPH: Subscribe Accent", accent, comp.width * 0.38, comp.height * 0.1, comp.width * 0.78, comp.height * 0.86, start, end));
      made.push(makeTemplateText(comp, text || "Subscribe", prefix + "MOGRAPH: Subscribe Text", comp.width * 0.78, comp.height * 0.86, Number(args.font_size || 42), white, start, end, font));
    } else if (id === "youtube-hook") {
      made.push(makeTemplateSolid(comp, prefix + "MOGRAPH: Hook Accent", accent, comp.width, comp.height, comp.width / 2, comp.height / 2, start, end));
      made.push(makeTemplateText(comp, text, prefix + "MOGRAPH: Hook Text", comp.width / 2, comp.height / 2, Number(args.font_size || 104), white, start, end, font));
    } else if (id === "end-screen") {
      made.push(makeTemplateSolid(comp, prefix + "MOGRAPH: End Screen Background", primary, comp.width, comp.height, comp.width / 2, comp.height / 2, start, end));
      made.push(makeTemplateText(comp, text || "Watch Next", prefix + "MOGRAPH: End Screen Title", comp.width / 2, comp.height * 0.3, Number(args.font_size || 80), white, start, end, font));
      made.push(makeTemplateText(comp, subtitle || "Subscribe for more", prefix + "MOGRAPH: End Screen CTA", comp.width / 2, comp.height * 0.72, Number(args.subtitle_size || 42), accent, start, end, font));
    } else {
      made.push(makeTemplateText(comp, text, prefix + "MOGRAPH: " + id, comp.width / 2, comp.height / 2, Number(args.font_size || 84), white, start, end, font));
    }
    if (style === "japanese-pop") {
      made.push(makeShapeRect(comp, prefix + "JP Transition Sweep", accent, comp.width * 0.06, comp.height * 1.2, -comp.width * 0.08, comp.height / 2, start, end, 0, 0));
      made = made.concat(makeJapaneseDecor(comp, prefix, String(args.scene_purpose || ""), primary, accent, white, start, end, font, safeMargin));
    }
    for (var mi = 0; mi < made.length; mi++) {
      if (style === "japanese-pop") animateMographLayer(made[mi], start, end, String(args.transition || "fade"), mi, String(args.scene_purpose || ""), comp, Number(args.energy || 0.86), safeMargin);
      else {
        fadeLayer(made[mi], start, end, Number(args.fade_duration === undefined ? 0.25 : args.fade_duration), !!args.hold_end);
        applyMotionEntrance(made[mi], start, String(args.transition || "fade"), Number(args.fade_duration || 0.25), comp);
      }
    }
    try { if (comp.markerProperty) comp.markerProperty.setValueAtTime(start, new MarkerValue(id + " | " + (args.scene_id || "scene"))); } catch (e2) {}
    return { template_id: id, comp: comp.name, layers: made.length, start: start, end: end, brand: { primary: primary, accent: accent, font: font } };
  }

  function renderComposition(args) {
    var comp = resolveComp(args);
    var outPath = String(args.output_path || (homeDir() + "/.ae-mcp/previews/" + comp.name.replace(/[^\\w\\-]+/g, "_") + "." + String(args.format || "mp4")));
    var outFile = new File(outPath);
    var parent = outFile.parent;
    if (parent && !parent.exists) parent.create();
    var rq = app.project.renderQueue.items.add(comp);
    var om = rq.outputModule(1);
    try { om.applyTemplate(String(args.output_preset || "Best Settings")); } catch (e0) {}
    om.file = outFile;
    app.project.renderQueue.render();
    return { comp: comp.name, path: outFile.fsName, format: args.format || "mp4", preset: args.output_preset || "Best Settings", exists: outFile.exists, bytes: outFile.exists ? outFile.length : 0 };
  }

  $.global.__AE_MCP_DISPATCH__ = function (method, args, code) {
    args = args || {};
    switch (method) {
      case "system.ping":
        return { pong: true };
      case "system.health":
        return {
          connected: true,
          listening: true,
          aeVersion: String(app.version),
          projectOpen: !!app.project,
          projectName: app.project && app.project.file ? app.project.file.name : app.project ? "Untitled" : null,
          projectPath: app.project && app.project.file ? app.project.file.fsName : null,
          activeComp:
            app.project && app.project.activeItem && app.project.activeItem instanceof CompItem
              ? app.project.activeItem.name
              : null,
          numItems: app.project ? app.project.numItems : 0,
          bridge: "ae-mcp-bootstrap",
          protocolVersion: 1,
          home: homeDir()
        };
      case "project.info": {
        if (!app.project) throw { code: "NO_PROJECT", message: "No project open." };
        var comps = [];
        for (var i = 1; i <= app.project.numItems; i++) {
          var item = app.project.item(i);
          if (item instanceof CompItem) {
            comps.push({
              index: i,
              name: item.name,
              width: item.width,
              height: item.height,
              frameRate: item.frameRate,
              duration: item.duration,
              numLayers: item.numLayers
            });
          }
        }
        return {
          name: app.project.file ? app.project.file.name : "Untitled",
          path: app.project.file ? app.project.file.fsName : null,
          bitsPerChannel: app.project.bitsPerChannel,
          numItems: app.project.numItems,
          compositions: comps
        };
      }
      case "project.listComps":
        return $.global.__AE_MCP_DISPATCH__("project.info", args).compositions;
      case "project.search": {
        var q = String(args.query || "").toLowerCase();
        var results = [];
        var limit = args.limit || 50;
        if (!app.project) return { results: results };
        for (var si = 1; si <= app.project.numItems; si++) {
          var sitem = app.project.item(si);
          var type = sitem instanceof CompItem ? "comp" : sitem instanceof FolderItem ? "folder" : "footage";
          if (!q || sitem.name.toLowerCase().indexOf(q) !== -1) {
            results.push({ index: si, name: sitem.name, type: type });
          }
          if (sitem instanceof CompItem && args.include_layers !== false) {
            for (var L = 1; L <= sitem.numLayers; L++) {
              var ly = sitem.layer(L);
              if (!q || ly.name.toLowerCase().indexOf(q) !== -1) {
                results.push({ type: "layer", comp: sitem.name, layer_index: L, name: ly.name });
              }
            }
          }
          if (results.length >= limit) break;
        }
        return { results: results, truncated: results.length >= limit };
      }
      case "comp.get":
        return compSummary(resolveComp(args), args.response_format !== "concise");
      case "comp.create": {
        var comp = app.project.items.addComp(
          args.name || "Comp",
          Number(args.width || 1920),
          Number(args.height || 1080),
          Number(args.pixelAspect || 1),
          Number(args.duration || 5),
          Number(args.frameRate || 30)
        );
        if (args.bgColor) {
          try {
            comp.bgColor = colorToRgb(args.bgColor);
          } catch (e) {}
        }
        return compSummary(comp, true);
      }
      case "layer.get":
        return layerSummary(resolveLayer(resolveComp(args), args), args.response_format !== "concise");
      case "layer.create": {
        var c2 = resolveComp(args);
        var type = String(args.type || "solid");
        var name = args.name || type;
        var layer = null;
        if (type === "text") {
          layer = c2.layers.addText(args.text || "Text");
          layer.name = name;
          try {
            var td = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
            if (args.fontSize) td.fontSize = Number(args.fontSize);
            if (args.fillColor) td.fillColor = colorToRgb(args.fillColor);
            if (args.font) td.font = String(args.font);
            if (args.text) td.text = String(args.text);
            layer.property("ADBE Text Properties").property("ADBE Text Document").setValue(td);
          } catch (e) {}
        } else if (type === "solid" || type === "adjustment") {
          layer = c2.layers.addSolid(
            colorToRgb(args.color || [1, 1, 1]),
            name,
            Number(args.width || c2.width),
            Number(args.height || c2.height),
            1,
            c2.duration
          );
          if (type === "adjustment") layer.adjustmentLayer = true;
        } else if (type === "null") {
          layer = c2.layers.addNull(c2.duration);
          layer.name = name;
        } else if (type === "camera") {
          layer = c2.layers.addCamera(name, [c2.width / 2, c2.height / 2]);
        } else if (type === "light") {
          layer = c2.layers.addLight(name, [c2.width / 2, c2.height / 2]);
        } else if (type === "shape") {
          layer = c2.layers.addShape();
          layer.name = name;
          try {
            var contents = layer.property("ADBE Root Vectors Group");
            var group = contents.addProperty("ADBE Vector Group");
            var gContents = group.property("ADBE Vectors Group");
            var shapeType = String(args.shape || "rect");
            if (shapeType === "ellipse") {
              var ellipse = gContents.addProperty("ADBE Vector Shape - Ellipse");
              ellipse.property("ADBE Vector Ellipse Size").setValue([
                Number(args.sizeX || 200),
                Number(args.sizeY || 200)
              ]);
            } else {
              var rect = gContents.addProperty("ADBE Vector Shape - Rect");
              rect.property("ADBE Vector Rect Size").setValue([
                Number(args.sizeX || 200),
                Number(args.sizeY || 200)
              ]);
            }
            var fill = gContents.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue(colorToRgb(args.fillColor || [1, 1, 1]));
          } catch (e2) {}
        } else {
          throw { code: "BAD_LAYER_TYPE", message: "Unknown type: " + type };
        }
        applyLayerProps(layer, args);
        return layerSummary(layer, true);
      }
      case "layer.setProperties": {
        var lset = resolveLayer(resolveComp(args), args);
        applyLayerProps(lset, args);
        return layerSummary(lset, true);
      }
      case "layer.delete": {
        if (!args.confirm) {
          throw { code: "CONFIRM_REQUIRED", message: "Deleting requires confirm: true" };
        }
        var ld = resolveLayer(resolveComp(args), args);
        var info = { name: ld.name, index: ld.index };
        ld.remove();
        return { deleted: info };
      }
      case "layer.duplicate": {
        var ldu = resolveLayer(resolveComp(args), args);
        var dup = ldu.duplicate();
        if (args.new_name) dup.name = String(args.new_name);
        return layerSummary(dup, true);
      }
      case "anim.setKeyframes": {
        var lk = resolveLayer(resolveComp(args), args);
        var prop = resolveProperty(lk, args.property || args.property_path);
        var keys = args.keyframes || args.keys || [];
        for (var ki = 0; ki < keys.length; ki++) {
          prop.setValueAtTime(Number(keys[ki].time), keys[ki].value);
        }
        return {
          layer: lk.name,
          property: args.property || args.property_path,
          keyCount: prop.numKeys
        };
      }
      case "anim.setExpression": {
        var le = resolveLayer(resolveComp(args), args);
        var pe = resolveProperty(le, args.property || args.property_path);
        if (args.expression === null || args.expression === undefined || args.expression === "") {
          pe.expression = "";
          pe.expressionEnabled = false;
        } else {
          pe.expression = String(args.expression);
          pe.expressionEnabled = true;
        }
        return {
          layer: le.name,
          property: args.property || args.property_path,
          expression: pe.expression,
          expressionEnabled: pe.expressionEnabled
        };
      }
      case "fx.apply": {
        var lf = resolveLayer(resolveComp(args), args);
        var effectName = args.effect || args.matchName || args.name;
        if (!effectName) throw { code: "EFFECT_REQUIRED", message: "Pass effect or matchName" };
        var fx = lf.Effects.addProperty(String(effectName));
        return { index: fx.propertyIndex, name: fx.name, matchName: fx.matchName };
      }
      case "fx.setProperty": {
        var lfx = resolveLayer(resolveComp(args), args);
        var eg = lfx.property("ADBE Effect Parade");
        var fxi = null;
        if (args.effect_index) fxi = eg.property(Number(args.effect_index));
        else if (args.effect_name) {
          for (var ei = 1; ei <= eg.numProperties; ei++) {
            if (eg.property(ei).name === args.effect_name || eg.property(ei).matchName === args.effect_name) {
              fxi = eg.property(ei);
              break;
            }
          }
        }
        if (!fxi) throw { code: "EFFECT_NOT_FOUND", message: "Effect not found" };
        var propName = args.property || args.property_name;
        var ep = fxi.property(propName);
        if (!ep) throw { code: "PROP_NOT_FOUND", message: "Effect property not found: " + propName };
        ep.setValue(args.value);
        return { effect: fxi.name, property: propName, value: ep.value };
      }
      case "fx.remove": {
        var lr = resolveLayer(resolveComp(args), args);
        var egr = lr.property("ADBE Effect Parade");
        var fxr = null;
        if (args.effect_index) fxr = egr.property(Number(args.effect_index));
        else if (args.effect_name) {
          for (var ri = 1; ri <= egr.numProperties; ri++) {
            if (
              egr.property(ri).name === args.effect_name ||
              egr.property(ri).matchName === args.effect_name
            ) {
              fxr = egr.property(ri);
              break;
            }
          }
        }
        if (!fxr) throw { code: "EFFECT_NOT_FOUND", message: "Effect not found" };
        var removed = { name: fxr.name, matchName: fxr.matchName };
        fxr.remove();
        return { removed: removed };
      }
      case "fx.list": {
        var ll = resolveLayer(resolveComp(args), args);
        var egl = ll.property("ADBE Effect Parade");
        var list = [];
        if (egl) {
          for (var li = 1; li <= egl.numProperties; li++) {
            var fxl = egl.property(li);
            list.push({ index: li, name: fxl.name, matchName: fxl.matchName, enabled: fxl.enabled });
          }
        }
        return { layer: ll.name, effects: list };
      }
      case "view.captureFrame": {
        var cc = resolveComp(args);
        var t = args.time !== undefined && args.time !== null ? Number(args.time) : cc.time;
        var previewDir = new Folder(homeDir() + "/.ae-mcp/previews");
        if (!previewDir.exists) previewDir.create();
        var safeName = String(cc.name).replace(/[^\w\-]+/g, "_");
        var stamp = new Date().getTime();
        var outPath = previewDir.fsName + "/" + safeName + "_" + stamp + ".png";
        var file = new File(outPath);
        try {
          if (file.exists) file.remove();
        } catch (e0) {}
        var prevTime = cc.time;
        try {
          try {
            cc.openInViewer();
          } catch (eView) {}
          cc.time = t;
          cc.saveFrameToPng(t, file);
        } catch (e) {
          try {
            cc.time = prevTime;
          } catch (e1) {}
          throw { code: "CAPTURE_FAILED", message: "saveFrameToPng failed: " + String(e) };
        }
        try {
          cc.time = prevTime;
        } catch (e2) {}
        file = new File(outPath);
        return {
          path: file.fsName,
          comp: cc.name,
          time: t,
          width: cc.width,
          height: cc.height,
          bytes: file.exists ? file.length : 0
        };
      }
      case "view.captureFrames": {
        var mcomp = resolveComp(args);
        var times = args.times || [];
        if (!(times instanceof Array) || !times.length) throw { code: "TIMES_REQUIRED", message: "Pass times: [0, 1.5, 3]" };
        var frames = [];
        var mdir = new Folder(homeDir() + "/.ae-mcp/previews");
        if (!mdir.exists) mdir.create();
        var oldTime = mcomp.time;
        for (var mti = 0; mti < times.length; mti++) {
          var mt = Math.max(0, Math.min(mcomp.duration, Number(times[mti])));
          var mp = mdir.fsName + "/" + mcomp.name.replace(/[^\\w\\-]+/g, "_") + "_qa_" + mti + "_" + new Date().getTime() + ".png";
          var mf = new File(mp);
          mcomp.time = mt;
          mcomp.saveFrameToPng(mt, mf);
          frames.push({ time: mt, path: mf.fsName, bytes: mf.exists ? mf.length : 0 });
        }
        mcomp.time = oldTime;
        return { comp: mcomp.name, frames: frames, count: frames.length };
      }
      case "motion.createTemplate": {
        return createMotionTemplate(args);
      }
      case "comp.render": {
        return renderComposition(args);
      }
      case "system.runJsx": {
        var body = code || args.code || "";
        if (!body) throw { code: "NO_CODE", message: "No JSX code provided" };
        var fn = new Function("args", body);
        return { result: fn(args.args || args || {}) };
      }
      case "footage.import": {
        var fpath = args.path || args.file;
        if (!fpath) throw { code: "PATH_REQUIRED", message: "Pass path to media file" };
        var ff = new File(String(fpath));
        if (!ff.exists) throw { code: "FILE_NOT_FOUND", message: "File not found: " + fpath };
        var io = new ImportOptions(ff);
        if (!io.canImportAs(ImportAsType.FOOTAGE)) {
          throw { code: "IMPORT_FAIL", message: "Cannot import as footage" };
        }
        io.importAs = ImportAsType.FOOTAGE;
        var ftg = app.project.importFile(io);
        return {
          name: ftg.name,
          duration: ftg.duration,
          width: ftg.width,
          height: ftg.height,
          id: ftg.id
        };
      }

      /** Import image sequence (e.g. Blender PNG frames) */
      case "footage.importSequence": {
        var seqPath = args.path || args.first_frame;
        if (!seqPath) throw { code: "PATH_REQUIRED", message: "Pass path to first frame of sequence" };
        var sf = new File(String(seqPath));
        if (!sf.exists) throw { code: "FILE_NOT_FOUND", message: "File not found: " + seqPath };
        var sio = new ImportOptions(sf);
        sio.importAs = ImportAsType.FOOTAGE;
        try {
          sio.sequence = true;
        } catch (es) {}
        var sftg = app.project.importFile(sio);
        // Optionally add to a new or existing comp
        var result = {
          name: sftg.name,
          duration: sftg.duration,
          width: sftg.width,
          height: sftg.height,
          id: sftg.id,
          sequence: true
        };
        if (args.add_to_comp || args.comp_name) {
          var sc = null;
          if (args.comp_name) {
            try {
              sc = resolveComp({ comp_name: args.comp_name });
            } catch (e) {
              sc = null;
            }
          }
          if (!sc && args.create_comp !== false) {
            var sw = sftg.width || 1920;
            var sh = sftg.height || 1080;
            var sdur = sftg.duration > 0 ? sftg.duration : 3;
            sc = app.project.items.addComp(
              args.comp_name || "Blender 3D",
              sw,
              sh,
              1,
              sdur,
              Number(args.frameRate || 30)
            );
          }
          if (sc) {
            var sl = sc.layers.add(sftg);
            sl.name = args.layer_name || "Blender 3D";
            if (args.threeD) sl.threeDLayer = true;
            result.comp = sc.name;
            result.layer = sl.name;
            try {
              sc.openInViewer();
            } catch (ev) {}
          }
        }
        return result;
      }
      case "subtitle.create": {
        var sc = resolveComp(args);
        var text = args.text != null ? String(args.text) : "Subtitle";
        var tIn = args.inPoint != null ? Number(args.inPoint) : sc.time;
        var tOut = args.outPoint != null ? Number(args.outPoint) : tIn + 2;
        if (tOut <= tIn) tOut = tIn + 1;

        var sl = sc.layers.addText(text);
        sl.name = args.name || "SUB: " + text.substring(0, 28);
        var std = sl.property("ADBE Text Properties").property("ADBE Text Document").value;
        std.resetCharStyle();
        std.fontSize = Number(args.fontSize || Math.round(sc.height * 0.042));
        std.fillColor = args.fillColor ? colorToRgb(args.fillColor) : [1, 1, 1];
        std.applyFill = true;
        var useStroke = args.stroke !== false;
        std.applyStroke = useStroke;
        if (useStroke) {
          std.strokeColor = args.strokeColor ? colorToRgb(args.strokeColor) : [0, 0, 0];
          std.strokeWidth = Number(args.strokeWidth != null ? args.strokeWidth : 2);
          std.strokeOverFill = false;
        }
        try {
          std.font = args.font ? String(args.font) : "Arial Bold";
        } catch (ef) {
          try {
            std.font = "Arial";
          } catch (ef2) {}
        }
        std.justification = ParagraphJustification.CENTER_JUSTIFY;
        std.text = text;
        sl.property("ADBE Text Properties").property("ADBE Text Document").setValue(std);

        var y = args.y != null ? Number(args.y) : sc.height * 0.88;
        var x = args.x != null ? Number(args.x) : sc.width / 2;
        sl.property("ADBE Transform Group").property("ADBE Position").setValue([x, y]);
        sl.inPoint = tIn;
        sl.outPoint = tOut;

        if (args.fade !== false) {
          try {
            var op = sl.property("ADBE Transform Group").property("ADBE Opacity");
            var fd = Number(args.fadeDuration != null ? args.fadeDuration : 0.1);
            op.setValueAtTime(tIn, 0);
            op.setValueAtTime(tIn + fd, 100);
            op.setValueAtTime(Math.max(tIn + fd, tOut - fd), 100);
            op.setValueAtTime(tOut, 0);
          } catch (eop) {}
        }

        if (args.background_bar === true) {
          var bh = Number(args.barHeight || sc.height * 0.1);
          var barLayer = sc.layers.addSolid(
            args.barColor ? colorToRgb(args.barColor) : [0, 0, 0],
            "SUB BAR (explicit)",
            Math.round(sc.width * 0.92),
            Math.round(bh),
            1,
            sc.duration
          );
          barLayer.property("ADBE Transform Group").property("ADBE Position").setValue([sc.width / 2, y]);
          barLayer.property("ADBE Transform Group").property("ADBE Opacity").setValue(
            Number(args.barOpacity != null ? args.barOpacity : 45)
          );
          barLayer.inPoint = tIn;
          barLayer.outPoint = tOut;
          barLayer.moveAfter(sl);
        }

        return {
          layer: sl.name,
          index: sl.index,
          inPoint: tIn,
          outPoint: tOut,
          background_bar: args.background_bar === true,
          note:
            args.background_bar === true
              ? "Background bar added because background_bar:true was set."
              : "No background bar (default). Stroke used for readability."
        };
      }
      case "edit.fromCuts": {
        var fpath2 = args.path || args.file;
        var footage = null;
        if (fpath2) {
          var ff2 = new File(String(fpath2));
          if (!ff2.exists) throw { code: "FILE_NOT_FOUND", message: String(fpath2) };
          var io2 = new ImportOptions(ff2);
          io2.importAs = ImportAsType.FOOTAGE;
          footage = app.project.importFile(io2);
        } else if (args.footage_name) {
          for (var fi = 1; fi <= app.project.numItems; fi++) {
            var it = app.project.item(fi);
            if (it instanceof FootageItem && it.name === args.footage_name) {
              footage = it;
              break;
            }
          }
        }
        if (!footage) throw { code: "FOOTAGE_REQUIRED", message: "Pass path or footage_name" };

        var segs = args.segments || args.keep || [];
        if (!(segs instanceof Array) || segs.length === 0) {
          throw { code: "SEGMENTS_REQUIRED", message: "Pass segments: [{start,end},...]" };
        }

        var srcDur = footage.duration;
        var W = footage.width || 1920;
        var H = footage.height || 1080;
        var FPS = Number(args.frameRate || 30);
        var clean = [];
        for (var si = 0; si < segs.length; si++) {
          var a = Math.max(0, Number(segs[si].start));
          var b = Math.min(srcDur - 0.01, Number(segs[si].end));
          if (b > a + 0.15) clean.push([a, b]);
        }
        var total = 0;
        for (var ti = 0; ti < clean.length; ti++) total += clean[ti][1] - clean[ti][0];
        var cname = args.comp_name || "Smart Edit";
        var ecomp = app.project.items.addComp(cname, W, H, 1, total + 0.5, FPS);
        ecomp.bgColor = [0, 0, 0];

        var tl = 0;
        var cutList = [];
        for (var ei = 0; ei < clean.length; ei++) {
          var sin = clean[ei][0];
          var sout = clean[ei][1];
          var len = sout - sin;
          var elayer = ecomp.layers.add(footage);
          elayer.name = "Keep " + (ei + 1) + " (" + sin.toFixed(2) + "-" + sout.toFixed(2) + ")";
          elayer.startTime = tl - sin;
          elayer.inPoint = tl;
          elayer.outPoint = tl + len;
          cutList.push({ name: elayer.name, timeline: tl, len: len, sourceIn: sin, sourceOut: sout });
          try {
            var mk = new MarkerValue("Keep " + (ei + 1));
            ecomp.markerProperty.setValueAtTime(tl, mk);
          } catch (em) {}
          tl += len;
        }

        try {
          ecomp.openInViewer();
        } catch (ev) {}

        return {
          comp: ecomp.name,
          sourceDuration: srcDur,
          editDuration: total,
          cuts: cutList.length,
          cutList: cutList,
          removedApprox: srcDur - total
        };
      }
      default:
        throw {
          code: "UNKNOWN_METHOD",
          message: "Unknown method: " + method
        };
    }
  };
})();
