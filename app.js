(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const serializer = new XMLSerializer();
  const parser = new DOMParser();
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    svgName: "",
    svgMarkup: "",
    mapRegions: [],
    dataName: "",
    dataSource: "",
    headers: [],
    rows: [],
    matches: [],
    backgroundImage: "",
    logoImage: "",
    previewZoom: 1,
    renderedSvg: "",
    renderTimer: null,
  };

  const controls = [
    "colorMode", "colorLow", "colorHigh", "colorEmpty", "strokeColor",
    "strokeWidth", "backgroundColor", "transparentPreview", "mapTitle",
    "titleColor", "titleSize", "labelColor", "labelSize", "showLabels",
    "useThousands", "showTooltip", "labelLayout", "labelDecimals", "labelFitMode",
    "showLegend", "mapScale", "mapOffsetX", "mapOffsetY", "mapRotation", "mapAspect",
  ];

  function toast(message, duration = 2600) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), duration);
  }

  function setStatus(message) {
    $("statusText").textContent = message;
  }

  function setBusy(active, title = "正在处理", message = "请稍候…") {
    $("busyTitle").textContent = title;
    $("busyMessage").textContent = message;
    $("busyOverlay").classList.toggle("hidden", !active);
  }

  function showPanel(id) {
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === id);
    });
    document.querySelectorAll(".step").forEach((step) => {
      step.classList.toggle("active", step.dataset.panel === id);
    });
  }

  function updateReadiness() {
    const hasSvg = Boolean(state.svgMarkup);
    const hasData = state.rows.length > 0;
    const ready = hasSvg && hasData && state.matches.length > 0;
    $("stepImportState").textContent = hasSvg && hasData ? "已完成" : "待完成";
    const matched = state.matches.filter((item) => item.mapKey).length;
    $("stepMatchState").textContent = state.matches.length ? `${matched}/${state.matches.length}` : "待完成";
    $("exportButton").disabled = !ready;
    $("exportTopButton").disabled = !ready;
    $("runMatchButton").disabled = !(hasSvg && hasData);
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function sanitizeSvgDocument(doc) {
    doc.querySelectorAll("script, foreignObject, iframe, object, embed, audio, video").forEach((node) => node.remove());
    doc.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on")) node.removeAttribute(attribute.name);
        if ((name === "href" || name.endsWith(":href")) && /^(javascript:|https?:|file:)/.test(value)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
  }

  function directTitle(node) {
    const title = [...node.children].find((child) => child.localName === "title");
    return title?.textContent?.trim() || "";
  }

  function usefulLabel(node) {
    const raw = [
      node.getAttribute("data-name"),
      node.getAttribute("data-region"),
      node.getAttribute("name"),
      node.getAttribute("aria-label"),
      directTitle(node),
      node.id,
    ].find((value) => value && value.trim());
    if (!raw) return "";
    const value = raw.trim();
    if (/^(path|shape|group|layer|svg|clip|mask|item)[-_]?\d*$/i.test(value)) return "";
    return value;
  }

  function extractMapRegions(doc) {
    const root = doc.documentElement;
    let nodes = [...root.querySelectorAll("g, path, polygon, polyline, rect, circle, ellipse")];
    const labeled = nodes.filter((node) => usefulLabel(node));
    if (labeled.length) {
      nodes = labeled.filter((node) => {
        const labeledAncestor = node.parentElement?.closest?.("[data-name],[data-region],[name],[aria-label]");
        return !labeledAncestor || labeledAncestor === root;
      });
    } else {
      nodes = nodes.filter((node) =>
        ["path", "polygon", "polyline"].includes(node.localName) &&
        !node.closest("defs, clipPath, mask, pattern")
      );
    }

    const seen = new Set();
    const regions = [];
    nodes.forEach((node, index) => {
      const label = usefulLabel(node) || `区域 ${index + 1}`;
      let key = node.id || `map-region-${index + 1}`;
      while (seen.has(key)) key = `${key}-${index + 1}`;
      seen.add(key);
      node.setAttribute("data-map-key", key);
      regions.push({ key, label });
    });
    return regions;
  }

  function numericDimension(value, fallback) {
    const parsed = Number.parseFloat(String(value || "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function ensureViewBox(root) {
    const current = root.getAttribute("viewBox");
    if (current) {
      const numbers = current.trim().split(/[\s,]+/).map(Number);
      if (numbers.length === 4 && numbers.every(Number.isFinite)) return numbers;
    }
    const width = numericDimension(root.getAttribute("width"), 1000);
    const height = numericDimension(root.getAttribute("height"), 700);
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    return [0, 0, width, height];
  }

  async function importSvg(file) {
    setBusy(true, "正在读取 SVG", "识别地图区域结构…");
    try {
      const text = await file.text();
      const doc = parser.parseFromString(text, "image/svg+xml");
      if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") {
        throw new Error("这不是有效的 SVG 文件");
      }
      await useSvgDocument(doc, file.name, fileSize(file.size));
    } catch (error) {
      toast(error.message || "SVG 读取失败");
      setStatus("SVG 读取失败");
    } finally {
      setBusy(false);
    }
  }

  async function useSvgDocument(doc, name, sourceMeta = "") {
      sanitizeSvgDocument(doc);
      ensureViewBox(doc.documentElement);
      const regions = extractMapRegions(doc);
      if (!regions.length) throw new Error("SVG 中没有找到可着色的区域图形");
      state.svgName = name;
      state.mapRegions = regions;
      state.svgMarkup = serializer.serializeToString(doc.documentElement);
      $("svgFileInfo").innerHTML = `<strong>${escapeHtml(name)}</strong><span>${regions.length} 个区域${sourceMeta ? ` · ${escapeHtml(sourceMeta)}` : ""}</span>`;
      $("svgFileInfo").classList.remove("hidden");
      $("mapRegionCount").textContent = String(regions.length);
      $("emptyCanvas").classList.add("hidden");
      $("previewStage").classList.remove("hidden");
      $("previewMeta").textContent = `${name} · ${regions.length} 个可识别区域`;
      setStatus(`已读取 SVG：${regions.length} 个区域`);
      await refreshPreview();
      autoRunIfReady();
      updateReadiness();
      toast(`已识别 ${regions.length} 个地图区域`);
  }

  function flattenJsonRecord(value, prefix = "", output = {}, depth = 0) {
    if (value === null || value === undefined || typeof value !== "object") {
      if (prefix) output[prefix] = value;
      return output;
    }
    if (Array.isArray(value)) {
      if (prefix) {
        output[prefix] = value.every((item) => typeof item !== "object")
          ? value.join(", ")
          : JSON.stringify(value);
      }
      return output;
    }
    Object.entries(value).forEach(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === "object" && !Array.isArray(item) && depth < 2) {
        flattenJsonRecord(item, path, output, depth + 1);
      } else if (Array.isArray(item)) {
        output[path] = item.every((entry) => typeof entry !== "object") ? item.join(", ") : JSON.stringify(item);
      } else {
        output[path] = item;
      }
    });
    return output;
  }

  function findJsonRows(value, path = "$", depth = 0, candidates = []) {
    if (depth > 6 || value === null || value === undefined) return candidates;
    if (Array.isArray(value)) {
      if (value.length) {
        const objectCount = value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).length;
        const arrayCount = value.filter(Array.isArray).length;
        const commonPath = /(?:^|\.)(data|list|rows|items|records|results?|content|features)$/i.test(path);
        const score = Math.min(value.length, 500) + objectCount * 100 + arrayCount * 3 + (commonPath ? 100000 : 0);
        candidates.push({ list: value, path, score });
      }
      value.slice(0, 20).forEach((item, index) => {
        if (item && typeof item === "object") findJsonRows(item, `${path}[${index}]`, depth + 1, candidates);
      });
      return candidates;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        if (item && typeof item === "object") findJsonRows(item, `${path}.${key}`, depth + 1, candidates);
      });
    }
    return candidates;
  }

  function rowsFromJson(data) {
    const candidates = findJsonRows(data).sort((a, b) => b.score - a.score);
    let list = candidates[0]?.list;
    let sourcePath = candidates[0]?.path || "$";
    if (!list) {
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const entries = Object.entries(data);
        const primitiveEntries = entries.filter(([, value]) => value === null || typeof value !== "object");
        if (entries.length > 1 && primitiveEntries.length === entries.length) {
          return {
            headers: ["区域", "数值"],
            rows: entries.map(([region, value]) => ({ 区域: region, 数值: value })),
            sourcePath: "$（键值对象）",
          };
        }
      }
      list = [data];
    }
    if (!list.length) return { headers: [], rows: [], sourcePath };
    if (Array.isArray(list[0])) {
      const headers = list[0].map((value, index) => String(value ?? `字段${index + 1}`));
      return {
        headers,
        rows: list.slice(1).map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]]))),
        sourcePath,
      };
    }
    if (list.every((item) => item === null || typeof item !== "object")) {
      return {
        headers: ["序号", "数值"],
        rows: list.map((value, index) => ({ 序号: index + 1, 数值: value })),
        sourcePath,
      };
    }
    const rows = list.map((item) => flattenJsonRecord(item || {}));
    const headers = [...new Set(rows.flatMap((item) => Object.keys(item)))];
    return { headers, rows, sourcePath };
  }

  function rowsFromWorkbook(workbook) {
    const sheetName = workbook.SheetNames.find((name) => workbook.Sheets[name]["!ref"]) || workbook.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [] };
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null, raw: true });
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return { headers, rows };
  }

  function applyParsedData(parsed, name, sourceLabel = "") {
    if (!parsed.rows.length || !parsed.headers.length) throw new Error("没有读取到有效的数据行");
    state.dataName = name;
    state.dataSource = sourceLabel;
    state.headers = parsed.headers;
    state.rows = parsed.rows.filter((row) => Object.values(row).some((value) => value !== null && value !== ""));
    populateColumnSelectors();
    const pathText = parsed.sourcePath && parsed.sourcePath !== "$" ? ` · ${parsed.sourcePath}` : "";
    $("dataFileInfo").innerHTML = `<strong>${escapeHtml(name)}</strong><span>${state.rows.length} 行 · ${parsed.headers.length} 列${escapeHtml(pathText)}</span>`;
    $("dataFileInfo").classList.remove("hidden");
    $("columnMapping").classList.remove("hidden");
    setStatus(`已读取数据：${state.rows.length} 行`);
    autoRunIfReady();
    updateReadiness();
  }

  async function importData(file) {
    setBusy(true, "正在读取数据", "识别表头和数值列…");
    try {
      const extension = file.name.split(".").pop().toLowerCase();
      let parsed;
      if (extension === "json") {
        parsed = rowsFromJson(JSON.parse(await file.text()));
      } else {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
        parsed = rowsFromWorkbook(workbook);
      }
      applyParsedData(parsed, file.name, "file");
      toast(`已读取 ${state.rows.length} 行区域数据`);
    } catch (error) {
      toast(error.message || "数据文件读取失败");
      setStatus("数据文件读取失败");
    } finally {
      setBusy(false);
    }
  }

  function jsonInputValue(id, emptyValue = {}) {
    const text = $(id).value.trim();
    if (!text) return emptyValue;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${id === "apiHeaders" ? "请求头" : "请求体"}必须是 JSON 对象`);
    }
    return parsed;
  }

  function isGeoJson(data) {
    return data?.type === "FeatureCollection" && Array.isArray(data.features);
  }

  function projectedPoint(point) {
    const longitude = Number(point?.[0]);
    const latitude = Number(point?.[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    const lambda = longitude * Math.PI / 180;
    const safeLatitude = Math.max(-85, Math.min(85, latitude));
    const phi = safeLatitude * Math.PI / 180;
    const mercatorY = Math.log(Math.tan(Math.PI / 4 + phi / 2));
    return [lambda, -mercatorY];
  }

  function geometryRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates || [];
    if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).flat();
    return [];
  }

  function geoJsonToSvgDocument(data) {
    const features = data.features.filter((feature) => geometryRings(feature?.geometry).length);
    if (!features.length) throw new Error("GeoJSON 中没有找到 Polygon 或 MultiPolygon 区域");

    const allPoints = [];
    features.forEach((feature) => {
      geometryRings(feature.geometry).forEach((ring) => {
        ring.forEach((point) => {
          const projected = projectedPoint(point);
          if (projected) allPoints.push(projected);
        });
      });
    });
    if (!allPoints.length) throw new Error("GeoJSON 中没有有效的经纬度坐标");

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    allPoints.forEach(([x, y]) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
    const width = 1000;
    const height = 700;
    const padding = 34;
    const scale = Math.min((width - padding * 2) / Math.max(maxX - minX, 1), (height - padding * 2) / Math.max(maxY - minY, 1));
    const offsetX = (width - (maxX - minX) * scale) / 2;
    const offsetY = (height - (maxY - minY) * scale) / 2;
    const coordinate = (point) => {
      const projected = projectedPoint(point);
      if (!projected) return null;
      return [
        offsetX + (projected[0] - minX) * scale,
        offsetY + (projected[1] - minY) * scale,
      ];
    };

    const doc = document.implementation.createDocument(SVG_NS, "svg");
    const root = doc.documentElement;
    root.setAttribute("xmlns", SVG_NS);
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));

    features.forEach((feature, index) => {
      const properties = feature.properties || {};
      const label = String(properties.name || properties.NAME || properties.adcode || feature.id || `区域 ${index + 1}`);
      const group = doc.createElementNS(SVG_NS, "g");
      group.setAttribute("id", `geo-${String(properties.adcode || feature.id || index + 1).replace(/[^\w-]/g, "-")}`);
      group.setAttribute("data-name", label);
      const path = doc.createElementNS(SVG_NS, "path");
      const parts = geometryRings(feature.geometry).map((ring) => {
        const points = ring.map(coordinate).filter(Boolean);
        if (points.length < 3) return "";
        return `M ${points.map((point) => `${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join(" L ")} Z`;
      }).filter(Boolean);
      if (!parts.length) return;
      path.setAttribute("d", parts.join(" "));
      path.setAttribute("fill", "#dbeafe");
      path.setAttribute("stroke", "#ffffff");
      path.setAttribute("stroke-width", "1");
      path.setAttribute("fill-rule", "evenodd");
      group.appendChild(path);
      const labelAnchor = coordinate(properties.centroid || properties.center);
      if (labelAnchor) {
        group.setAttribute("data-label-x", labelAnchor[0].toFixed(2));
        group.setAttribute("data-label-y", labelAnchor[1].toFixed(2));
      }
      root.appendChild(group);
    });
    return doc;
  }

  async function importGeoJsonMap(data, sourceName) {
    const doc = geoJsonToSvgDocument(data);
    await useSvgDocument(doc, `GeoJSON · ${sourceName}`, `${data.features.length} 个要素`);
  }

  async function importJsonApi() {
    const url = $("apiUrl").value.trim();
    if (!url) {
      toast("请先输入 JSON API 地址");
      $("apiUrl").focus();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error();
    } catch {
      toast("请输入以 http:// 或 https:// 开头的有效地址");
      return;
    }

    setBusy(true, "正在请求 JSON API", "获取数据并识别区域字段…");
    $("fetchApiButton").disabled = true;
    try {
      const method = $("apiMethod").value;
      const headers = jsonInputValue("apiHeaders");
      const options = {
        method,
        headers,
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      };
      if (method === "POST") {
        const body = jsonInputValue("apiBody");
        options.body = JSON.stringify(body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
      const response = await fetch(parsedUrl.href, options);
      if (!response.ok) throw new Error(`API 返回 ${response.status} ${response.statusText}`);
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("API 返回的内容不是有效 JSON");
      }
      if (isGeoJson(json)) {
        setBusy(true, "正在生成 GeoJSON 地图", "转换区域边界为可编辑 SVG…");
        await importGeoJsonMap(json, parsedUrl.hostname);
        setStatus(state.rows.length
          ? `GeoJSON 地图已生成，并已匹配上传数据表的 ${state.rows.length} 行数据`
          : "GeoJSON 地图已生成；请继续上传 Excel、CSV 或数据 JSON");
        toast(`GeoJSON 地图读取成功：${json.features.length} 个区域`);
        return;
      }
      const parsed = rowsFromJson(json);
      applyParsedData(parsed, `API · ${parsedUrl.hostname}`, parsedUrl.href);
      toast(`API 数据读取成功：${state.rows.length} 行`);
    } catch (error) {
      const message = error instanceof SyntaxError
        ? "请求头或请求体不是有效 JSON"
        : error.message || "JSON API 请求失败";
      toast(message, 4200);
      setStatus(`${message}；若浏览器提示跨域，请让 API 开启 CORS`);
    } finally {
      $("fetchApiButton").disabled = false;
      setBusy(false);
    }
  }

  function populateSelect(select, allowNone = false) {
    select.innerHTML = "";
    if (allowNone) select.add(new Option("不使用", ""));
    state.headers.forEach((header) => select.add(new Option(header, header)));
  }

  function chooseHeader(pattern, fallback = "") {
    return state.headers.find((header) => pattern.test(String(header))) || fallback;
  }

  function isMostlyNumeric(header) {
    const values = state.rows.slice(0, 30).map((row) => row[header]).filter((value) => value !== null && value !== "");
    return values.length > 0 && values.filter((value) => Number.isFinite(Number(String(value).replace(/,/g, "")))).length / values.length >= 0.7;
  }

  function populateColumnSelectors() {
    populateSelect($("regionColumn"));
    populateSelect($("valueColumn"));
    populateSelect($("labelColumn"), true);
    populateSelect($("colorColumn"), true);

    $("regionColumn").value = chooseHeader(/省|市|区|县|区域|地区|region|area|name/i, state.headers[0]);
    $("valueColumn").value = chooseHeader(/数值|数量|收入|销售|金额|value|amount|count|revenue|children|num/i,
      state.headers.find(isMostlyNumeric) || state.headers[1] || state.headers[0]);
    $("labelColumn").value = state.headers.find((header) =>
      /(?:^|\.)(?:标签|说明|label|备注)$/i.test(String(header))
    ) || "";
    $("colorColumn").value = chooseHeader(/颜色|色值|color|colour/i, "");
    populateLabelFieldChoices();
  }

  function populateLabelFieldChoices() {
    const fields = allowedLabelFields();
    const defaults = new Set(recommendedLabelFields());
    $("labelFieldList").innerHTML = fields.map((header) => `
      <label class="label-field-option" title="${escapeHtml(header)}">
        <input type="checkbox" value="${escapeHtml(header)}" ${defaults.has(header) ? "checked" : ""}>
        <span>${escapeHtml(labelFieldOptionText(header))}</span>
      </label>
    `).join("");
    $("labelFieldControls").classList.toggle("hidden", !fields.length);
    updateLabelPreview();
  }

  const amountFieldPattern = /成交金额|交易金额|支付金额|销售金额|销售额|商家收入|收入|gmv|revenue|amount/i;
  const countFieldPattern = /成交条数|成交笔数|成交数量|交易笔数|订单数量|订单量|商品数量|销量|数量|件数|count|quantity|qty/i;

  function allowedLabelFields() {
    return [...state.headers];
  }

  function displayFieldName(header) {
    if (header === $("regionColumn").value) return "省";
    if (countFieldPattern.test(String(header))) return "成交条数";
    if (amountFieldPattern.test(String(header))) return "成交金额";
    return String(header);
  }

  function labelFieldOptionText(header) {
    const displayName = displayFieldName(header);
    return displayName === header ? displayName : `${displayName}（${header}）`;
  }

  function recommendedLabelFields() {
    const regionField = $("regionColumn").value;
    const countField = chooseHeader(countFieldPattern, "");
    const amountField = chooseHeader(amountFieldPattern, "");
    return [...new Set([regionField, countField, amountField].filter(Boolean))];
  }

  function applyRecommendedLabelFields() {
    const selected = new Set(recommendedLabelFields());
    $("labelFieldList").querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = selected.has(input.value);
    });
    updateLabelPreview();
    schedulePreview();
  }

  function selectedLabelFields() {
    return [...$("labelFieldList").querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.value);
  }

  function formatLabelValue(value, header = "") {
    if (value === null || value === undefined || value === "") return "";
    if (/编码|代码|编号|邮编|id|code|adcode/i.test(header)) return String(value);
    const numeric = numberValue(value);
    if (numeric === null || typeof value === "boolean") return String(value);
    const decimals = Number($("labelDecimals").value) || 0;
    return new Intl.NumberFormat("zh-CN", {
      useGrouping: $("useThousands").checked,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(numeric);
  }

  function labelLinesForMatch(item) {
    const row = state.rows[item.rowIndex] || {};
    const lines = selectedLabelFields().map((header) => {
      const value = formatLabelValue(row[header], header);
      if (!value) return "";
      return value;
    }).filter(Boolean);
    const fallback = [item.label || item.sourceName].filter(Boolean);
    const result = lines.length ? lines : fallback;
    return $("labelLayout").value === "inline" ? [result.join(" · ")] : result;
  }

  function updateLabelPreview() {
    if (!state.rows.length) {
      $("labelPreviewExample").textContent = "导入数据后显示";
      return;
    }
    const previewItem = state.matches.find((item) => item.mapKey) || {
      rowIndex: 0,
      label: String(state.rows[0]?.[$("regionColumn").value] ?? ""),
      sourceName: String(state.rows[0]?.[$("regionColumn").value] ?? ""),
    };
    $("labelPreviewExample").textContent = labelLinesForMatch(previewItem).join("\n");
  }

  function addRegionTooltip(doc, node, item) {
    node.querySelectorAll(':scope > title[data-app-tooltip="true"]').forEach((title) => title.remove());
    if (!$("showTooltip").checked) return;
    const title = doc.createElementNS(SVG_NS, "title");
    title.setAttribute("data-app-tooltip", "true");
    title.textContent = labelLinesForMatch(item).join(" · ");
    node.insertBefore(title, node.firstChild);
  }

  const aliases = new Map(Object.entries({
    "内蒙古自治区": "内蒙古", "广西壮族自治区": "广西", "宁夏回族自治区": "宁夏",
    "新疆维吾尔自治区": "新疆", "西藏自治区": "西藏",
    "香港特别行政区": "香港", "澳门特别行政区": "澳门",
  }));

  function normalizeRegion(value) {
    let text = String(value ?? "").trim().toLowerCase().replace(/[\s·•_\-—()（）]/g, "");
    text = aliases.get(text) || text;
    return text
      .replace(/维吾尔自治区$|壮族自治区$|回族自治区$|特别行政区$|自治区$/g, "")
      .replace(/省$|市$|地区$|盟$|自治州$|自治县$|县$|区$/g, "");
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 2) return 0.88;
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        rows[i][j] = Math.min(
          rows[i - 1][j] + 1,
          rows[i][j - 1] + 1,
          rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return 1 - rows[a.length][b.length] / Math.max(a.length, b.length);
  }

  function numberValue(value) {
    const parsed = Number(String(value ?? "").replace(/[,\s￥¥]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function validColor(value) {
    const text = String(value ?? "").trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
      /^(?:rgb|hsl)a?\(/i.test(text) ? text : "";
  }

  function runMatching() {
    if (!state.svgMarkup || !state.rows.length) return;
    const regionColumn = $("regionColumn").value;
    const valueColumn = $("valueColumn").value;
    const labelColumn = $("labelColumn").value;
    const colorColumn = $("colorColumn").value;
    const candidates = state.mapRegions.map((region) => ({ ...region, normalized: normalizeRegion(region.label) }));
    const used = new Set();

    state.matches = state.rows.map((row, index) => {
      const sourceName = String(row[regionColumn] ?? "").trim();
      const normalized = normalizeRegion(sourceName);
      const ranked = candidates
        .filter((candidate) => !used.has(candidate.key))
        .map((candidate) => ({ candidate, score: similarity(normalized, candidate.normalized) }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      const mapKey = best && best.score >= 0.66 ? best.candidate.key : "";
      if (mapKey) used.add(mapKey);
      return {
        rowIndex: index,
        sourceName,
        value: numberValue(row[valueColumn]),
        label: String((labelColumn && row[labelColumn]) ?? sourceName),
        reportColor: colorColumn ? validColor(row[colorColumn]) : "",
        manualColor: "#5a66e8",
        mapKey,
        score: mapKey ? best.score : 0,
      };
    });
    renderMatchList();
    updateMatchSummary();
    updateReadiness();
    refreshPreview();
    showPanel("matchPanel");
    toast(`自动匹配完成：${state.matches.filter((item) => item.mapKey).length}/${state.matches.length}`);
  }

  function updateMatchSummary() {
    const matched = state.matches.filter((item) => item.mapKey).length;
    $("matchedCount").textContent = String(matched);
    $("unmatchedCount").textContent = String(state.matches.length - matched);
    $("mapRegionCount").textContent = String(state.mapRegions.length);
    $("stepMatchState").textContent = `${matched}/${state.matches.length}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;",
    })[char]);
  }

  function renderMatchList() {
    const search = $("matchSearch").value.trim().toLowerCase();
    const filter = $("matchFilter").value;
    const rows = state.matches.filter((item) => {
      if (search && !item.sourceName.toLowerCase().includes(search)) return false;
      if (filter === "matched" && !item.mapKey) return false;
      if (filter === "unmatched" && item.mapKey) return false;
      return true;
    });
    if (!rows.length) {
      $("matchList").innerHTML = '<div class="empty-compact">没有符合条件的区域</div>';
      return;
    }
    $("matchList").innerHTML = rows.map((item) => {
      const options = ['<option value="">未匹配</option>'].concat(state.mapRegions.map((region) =>
        `<option value="${escapeHtml(region.key)}" ${region.key === item.mapKey ? "selected" : ""}>${escapeHtml(region.label)}</option>`
      )).join("");
      const score = item.mapKey ? `${Math.round(item.score * 100)}%` : "请手动选择";
      return `<div class="match-row ${item.mapKey ? "" : "unmatched"}" data-row-index="${item.rowIndex}">
        <div class="match-source"><strong>${escapeHtml(item.sourceName || `第 ${item.rowIndex + 1} 行`)}</strong><small>${score}</small></div>
        <select class="manual-map-select" aria-label="${escapeHtml(item.sourceName)}的地图区域">${options}</select>
        <input class="manual-color-input" type="color" value="${item.manualColor}" aria-label="${escapeHtml(item.sourceName)}的颜色">
      </div>`;
    }).join("");
  }

  function autoRunIfReady() {
    if (state.svgMarkup && state.rows.length) runMatching();
  }

  function createSvgElement(name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function hexRgb(hex) {
    const value = hex.replace("#", "");
    const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
    return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16));
  }

  function mixColor(a, b, ratio) {
    const x = hexRgb(a);
    const y = hexRgb(b);
    const values = x.map((value, index) => Math.round(value + (y[index] - value) * ratio));
    return `#${values.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function colorForMatch(item, min, max) {
    const mode = $("colorMode").value;
    if (mode === "manual") return item.manualColor;
    if (mode === "report" && item.reportColor) return item.reportColor;
    if (item.value === null) return $("colorEmpty").value;
    const ratio = max === min ? 0.55 : Math.max(0, Math.min(1, (item.value - min) / (max - min)));
    if (mode === "bins") {
      const colors = [...document.querySelectorAll(".bin-color")].map((input) => input.value);
      return colors[Math.min(colors.length - 1, Math.floor(ratio * colors.length))];
    }
    return mixColor($("colorLow").value, $("colorHigh").value, ratio);
  }

  function applyRegionStyle(node, fill) {
    const targets = ["path", "polygon", "polyline", "rect", "circle", "ellipse"].includes(node.localName)
      ? [node]
      : [...node.querySelectorAll("path, polygon, polyline, rect, circle, ellipse")];
    targets.forEach((shape) => {
      shape.setAttribute("fill", fill);
      shape.style.fill = fill;
      shape.setAttribute("stroke", $("strokeColor").value);
      shape.style.stroke = $("strokeColor").value;
      shape.setAttribute("stroke-width", $("strokeWidth").value);
      shape.style.strokeWidth = $("strokeWidth").value;
      shape.style.vectorEffect = "non-scaling-stroke";
    });
  }

  function addBackground(root, viewBox) {
    const [x, y, width, height] = viewBox;
    const group = createSvgElement("g", { "data-app-background": "true" });
    const rect = createSvgElement("rect", {
      x, y, width, height,
      fill: $("backgroundColor").value,
    });
    group.appendChild(rect);
    if (state.backgroundImage) {
      const image = createSvgElement("image", {
        x, y, width, height,
        href: state.backgroundImage,
        preserveAspectRatio: "xMidYMid slice",
      });
      group.appendChild(image);
    }
    root.insertBefore(group, root.firstChild);
  }

  function addTitleLegendLogo(root, viewBox, min, max) {
    const [x, y, width, height] = viewBox;
    const title = $("mapTitle").value.trim();
    if (title) {
      const text = createSvgElement("text", {
        x: x + width / 2,
        y: y + Math.max(36, height * 0.065),
        "text-anchor": "middle",
        fill: $("titleColor").value,
        "font-size": $("titleSize").value,
        "font-family": "-apple-system, PingFang SC, sans-serif",
        "font-weight": "700",
        "data-app-overlay": "title",
      });
      text.textContent = title;
      root.appendChild(text);
    }

    if ($("showLegend").checked && Number.isFinite(min) && Number.isFinite(max)) {
      const legend = createSvgElement("g", {
        transform: `translate(${x + width * 0.055} ${y + height * 0.88})`,
        "data-app-overlay": "legend",
      });
      const boxWidth = Math.max(24, width * 0.035);
      for (let i = 0; i < 5; i++) {
        const ratio = i / 4;
        const fill = $("colorMode").value === "bins"
          ? [...document.querySelectorAll(".bin-color")][i].value
          : mixColor($("colorLow").value, $("colorHigh").value, ratio);
        legend.appendChild(createSvgElement("rect", { x: i * boxWidth, y: 0, width: boxWidth + 0.5, height: 12, fill }));
      }
      const label = createSvgElement("text", {
        x: 0, y: 28, fill: $("labelColor").value,
        "font-size": Math.max(8, Number($("labelSize").value) * 0.85),
        "font-family": "-apple-system, PingFang SC, sans-serif",
      });
      label.textContent = `${formatNumber(min)}  —  ${formatNumber(max)}`;
      legend.appendChild(label);
      root.appendChild(legend);
    }

    if (state.logoImage) {
      root.appendChild(createSvgElement("image", {
        x: x + width * 0.83,
        y: y + height * 0.04,
        width: width * 0.12,
        height: height * 0.09,
        href: state.logoImage,
        preserveAspectRatio: "xMidYMid meet",
        opacity: "0.9",
        "data-app-overlay": "logo",
      }));
    }
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  }

  async function refreshPreview() {
    if (!state.svgMarkup) return;
    const doc = parser.parseFromString(state.svgMarkup, "image/svg+xml");
    const root = doc.documentElement;
    const viewBox = ensureViewBox(root);
    root.setAttribute("xmlns", SVG_NS);
    root.setAttribute("width", viewBox[2]);
    root.setAttribute("height", viewBox[3]);
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");

    if (!$("transparentPreview").checked) addBackground(root, viewBox);

    const values = state.matches.map((item) => item.value).filter(Number.isFinite);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;

    state.mapRegions.forEach((region) => {
      const node = root.querySelector(`[data-map-key="${cssEscape(region.key)}"]`);
      if (node) applyRegionStyle(node, $("colorEmpty").value);
    });
    state.matches.forEach((item) => {
      if (!item.mapKey) return;
      const node = root.querySelector(`[data-map-key="${cssEscape(item.mapKey)}"]`);
      if (node) {
        applyRegionStyle(node, colorForMatch(item, min, max));
        addRegionTooltip(doc, node, item);
      }
    });

    const movable = [...root.children].filter((node) =>
      !["defs", "style", "metadata", "title", "desc"].includes(node.localName) &&
      !node.hasAttribute("data-app-background")
    );
    const mapLayer = createSvgElement("g", { "data-app-map-layer": "true" });
    const [x, y, width, height] = viewBox;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const scale = Number($("mapScale").value) / 100;
    const aspect = Number($("mapAspect").value) / 100;
    const rotation = Number($("mapRotation").value) || 0;
    const dx = Number($("mapOffsetX").value) || 0;
    const dy = Number($("mapOffsetY").value) || 0;
    mapLayer.setAttribute(
      "transform",
      `translate(${dx} ${dy}) translate(${cx} ${cy}) rotate(${rotation}) scale(${scale * aspect} ${scale}) translate(${-cx} ${-cy})`
    );
    movable.forEach((node) => mapLayer.appendChild(node));
    root.appendChild(mapLayer);
    addTitleLegendLogo(root, viewBox, min, max);

    $("previewFrame").innerHTML = serializer.serializeToString(root);
    const liveRoot = $("previewFrame").querySelector("svg");
    const liveLayer = liveRoot.querySelector("[data-app-map-layer]");

    if ($("showLabels").checked && liveLayer) {
      state.matches.forEach((item) => {
        if (!item.mapKey) return;
        const node = liveRoot.querySelector(`[data-map-key="${cssEscape(item.mapKey)}"]`);
        if (!node || typeof node.getBBox !== "function") return;
        try {
          const box = node.getBBox();
          if (!box.width && !box.height) return;
          const lines = labelLinesForMatch(item);
          const configuredSize = Number($("labelSize").value) || 10;
          const longestLine = Math.max(1, ...lines.map((line) => [...String(line)].length));
          const fittedWidth = (box.width * 0.78) / (longestLine * 0.62);
          const fittedHeight = (box.height * 0.82) / Math.max(1, lines.length * 1.15);
          const fontSize = $("labelFitMode").value === "auto"
            ? Math.max(6, Math.min(configuredSize, fittedWidth, fittedHeight))
            : configuredSize;
          const anchorX = Number(node.getAttribute("data-label-x"));
          const anchorY = Number(node.getAttribute("data-label-y"));
          const labelX = Number.isFinite(anchorX) ? anchorX : box.x + box.width / 2;
          const labelY = Number.isFinite(anchorY) ? anchorY : box.y + box.height / 2;
          const text = createSvgElement("text", {
            x: labelX,
            y: labelY,
            "text-anchor": "middle",
            "dominant-baseline": "central",
            fill: $("labelColor").value,
            "font-size": fontSize.toFixed(2),
            "font-family": "-apple-system, PingFang SC, sans-serif",
            "font-weight": "600",
            "paint-order": "stroke",
            stroke: "rgba(255,255,255,0.75)",
            "stroke-width": Math.max(1.1, fontSize * 0.16).toFixed(2),
            "data-app-label": "true",
          });
          lines.forEach((line, index) => {
            const firstLineOffset = lines.length === 1 ? 0 : -0.56 * (lines.length - 1);
            const tspan = createSvgElement("tspan", {
              x: labelX,
              dy: index === 0 ? `${firstLineOffset}em` : "1.12em",
              "font-weight": index > 0 ? "750" : "600",
            });
            tspan.textContent = line;
            text.appendChild(tspan);
          });
          liveLayer.appendChild(text);
        } catch {
          // Some unusual SVG nodes do not expose a measurable box.
        }
      });
    }
    state.renderedSvg = serializer.serializeToString(liveRoot);
    updateReadiness();
  }

  function schedulePreview() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(refreshPreview, 80);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function readImage(file, target) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state[target] = reader.result;
      schedulePreview();
    };
    reader.readAsDataURL(file);
  }

  function svgVariant(transparent, width, height) {
    const doc = parser.parseFromString(state.renderedSvg, "image/svg+xml");
    const root = doc.documentElement;
    root.setAttribute("width", width);
    root.setAttribute("height", height);
    if (transparent) root.querySelectorAll("[data-app-background]").forEach((node) => node.remove());
    return serializer.serializeToString(root);
  }

  function blobFromCanvas(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片生成失败")), type, quality);
    });
  }

  async function rasterBlob(svgText, width, height, type, quality, forceBackground) {
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("SVG 无法转换为图片"));
        image.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (forceBackground) {
        context.fillStyle = $("backgroundColor").value || "#ffffff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image, 0, 0, width, height);
      return await blobFromCanvas(canvas, type, quality);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function exportMaps() {
    const types = {
      pngBg: $("exportPngBg").checked,
      pngTransparent: $("exportPngTransparent").checked,
      jpg: $("exportJpg").checked,
      svg: $("exportSvg").checked,
    };
    if (!Object.values(types).some(Boolean)) {
      toast("请至少选择一种导出格式");
      return;
    }
    const width = Math.max(64, Math.min(16000, Number($("exportWidth").value) || 2400));
    const height = Math.max(64, Math.min(16000, Number($("exportHeight").value) || 1600));
    const count = Math.max(1, Math.min(50, Number($("exportCount").value) || 1));
    const prefix = $("filePrefix").value.trim() || "区域地图";
    const quality = Number($("jpgQuality").value) / 100;

    setBusy(true, "正在生成地图", `准备 ${count} 份导出文件…`);
    try {
      await refreshPreview();
      const backgroundSvg = svgVariant(false, width, height);
      const transparentSvg = svgVariant(true, width, height);
      const baseFiles = [];
      if (types.pngBg) baseFiles.push({ suffix: "有背景", ext: "png", blob: await rasterBlob(backgroundSvg, width, height, "image/png", 1, false) });
      if (types.pngTransparent) baseFiles.push({ suffix: "透明", ext: "png", blob: await rasterBlob(transparentSvg, width, height, "image/png", 1, false) });
      if (types.jpg) baseFiles.push({ suffix: "有背景", ext: "jpg", blob: await rasterBlob(backgroundSvg, width, height, "image/jpeg", quality, true) });
      if (types.svg) baseFiles.push({ suffix: "矢量", ext: "svg", blob: new Blob([backgroundSvg], { type: "image/svg+xml;charset=utf-8" }) });

      const files = [];
      for (let copy = 1; copy <= count; copy++) {
        for (const item of baseFiles) {
          const number = count > 1 ? `-${String(copy).padStart(2, "0")}` : "";
          files.push({ name: `${prefix}-${item.suffix}${number}.${item.ext}`, blob: item.blob });
        }
      }
      await saveFiles(files);
      setStatus(`已生成 ${files.length} 个导出文件`);
      toast(`导出完成：${files.length} 个文件`);
    } catch (error) {
      toast(error.message || "导出失败", 4000);
      setStatus("导出失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveFiles(files) {
    if ("showDirectoryPicker" in window) {
      try {
        const directory = await window.showDirectoryPicker({ mode: "readwrite" });
        for (const file of files) {
          const handle = await directory.getFileHandle(file.name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(file.blob);
          await writable.close();
        }
        return;
      } catch (error) {
        if (error.name !== "AbortError") console.warn(error);
        if (error.name === "AbortError") throw new Error("已取消导出");
      }
    }
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      if (index < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 140));
    }
  }

  function resetStyles() {
    $("colorMode").value = "gradient";
    $("colorLow").value = "#dbeafe";
    $("colorHigh").value = "#1d4ed8";
    $("colorEmpty").value = "#e5e7eb";
    $("strokeColor").value = "#ffffff";
    $("strokeWidth").value = "1";
    $("backgroundColor").value = "#f8fafc";
    $("transparentPreview").checked = false;
    $("mapTitle").value = "";
    $("titleColor").value = "#0f172a";
    $("titleSize").value = "30";
    $("labelColor").value = "#0f172a";
    $("labelSize").value = "10";
    $("showLabels").checked = true;
    $("useThousands").checked = true;
    $("showTooltip").checked = true;
    $("labelLayout").value = "lines";
    $("labelDecimals").value = "0";
    $("labelFitMode").value = "auto";
    $("showLegend").checked = true;
    $("mapScale").value = "100";
    $("mapRotation").value = "0";
    $("mapAspect").value = "100";
    $("mapAspectOutput").textContent = "100%";
    $("mapOffsetX").value = "0";
    $("mapOffsetY").value = "0";
    state.backgroundImage = "";
    state.logoImage = "";
    $("backgroundImageName").textContent = "未选择";
    $("logoName").textContent = "未选择";
    updateColorModeControls();
    schedulePreview();
  }

  function updateColorModeControls() {
    const mode = $("colorMode").value;
    $("gradientControls").classList.toggle("hidden", mode === "bins" || mode === "manual");
    $("binControls").classList.toggle("hidden", mode !== "bins");
    $("colorColumn").closest("label").style.opacity = mode === "report" ? "1" : "0.7";
  }

  function setupDropZone(zoneId, inputId, handler) {
    const zone = $(zoneId);
    const input = $(inputId);
    ["dragenter", "dragover"].forEach((event) => zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((event) => zone.addEventListener(event, (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
    }));
    zone.addEventListener("drop", (event) => {
      const file = event.dataTransfer.files[0];
      if (file) handler(file);
    });
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (file) handler(file);
      input.value = "";
    });
  }

  document.querySelectorAll(".step").forEach((step) => {
    step.addEventListener("click", () => showPanel(step.dataset.panel));
  });
  setupDropZone("svgDropZone", "svgInput", importSvg);
  setupDropZone("dataDropZone", "dataInput", importData);
  $("fetchApiButton").addEventListener("click", importJsonApi);
  $("apiUrl").addEventListener("keydown", (event) => {
    if (event.key === "Enter") importJsonApi();
  });
  $("apiMethod").addEventListener("change", () => {
    $("apiBodyWrap").classList.toggle("hidden", $("apiMethod").value !== "POST");
  });

  $("emptyUploadButton").addEventListener("click", () => $("svgInput").click());
  $("runMatchButton").addEventListener("click", runMatching);
  $("rerunMatchButton").addEventListener("click", runMatching);
  $("matchSearch").addEventListener("input", renderMatchList);
  $("matchFilter").addEventListener("change", renderMatchList);
  $("matchList").addEventListener("change", (event) => {
    const row = event.target.closest(".match-row");
    if (!row) return;
    const item = state.matches.find((match) => match.rowIndex === Number(row.dataset.rowIndex));
    if (!item) return;
    if (event.target.classList.contains("manual-map-select")) {
      item.mapKey = event.target.value;
      item.score = item.mapKey ? 1 : 0;
    }
    if (event.target.classList.contains("manual-color-input")) item.manualColor = event.target.value;
    updateMatchSummary();
    updateReadiness();
    renderMatchList();
    schedulePreview();
  });

  $("labelFieldList").addEventListener("change", () => {
    updateLabelPreview();
    schedulePreview();
  });
  $("selectRecommendedFields").addEventListener("click", applyRecommendedLabelFields);
  $("clearLabelFields").addEventListener("click", () => {
    $("labelFieldList").querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = false;
    });
    updateLabelPreview();
    schedulePreview();
  });

  controls.forEach((id) => {
    const node = $(id);
    node.addEventListener(node.type === "text" || node.type === "number" || node.type === "range" ? "input" : "change", () => {
      if (id === "colorMode") updateColorModeControls();
      if (id === "mapScale") $("mapScaleOutput").textContent = `${node.value}%`;
      if (id === "mapAspect") $("mapAspectOutput").textContent = `${node.value}%`;
      if (["useThousands", "labelLayout", "labelDecimals"].includes(id)) updateLabelPreview();
      schedulePreview();
    });
  });
  document.querySelectorAll(".bin-color").forEach((node) => node.addEventListener("input", schedulePreview));

  $("backgroundImageInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $("backgroundImageName").textContent = file.name;
    readImage(file, "backgroundImage");
  });
  $("logoInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    $("logoName").textContent = file.name;
    readImage(file, "logoImage");
  });
  $("resetStyleButton").addEventListener("click", resetStyles);
  $("exportButton").addEventListener("click", exportMaps);
  $("exportTopButton").addEventListener("click", () => {
    showPanel("exportPanel");
    $("exportButton").focus();
  });
  $("jpgQuality").addEventListener("input", () => $("jpgQualityOutput").textContent = `${$("jpgQuality").value}%`);

  $("zoomInButton").addEventListener("click", () => {
    state.previewZoom = Math.min(2, state.previewZoom + 0.1);
    applyPreviewZoom();
  });
  $("zoomOutButton").addEventListener("click", () => {
    state.previewZoom = Math.max(0.5, state.previewZoom - 0.1);
    applyPreviewZoom();
  });
  $("fitButton").addEventListener("click", () => {
    state.previewZoom = 1;
    applyPreviewZoom();
  });

  function applyPreviewZoom() {
    $("previewStage").style.transform = `scale(${state.previewZoom})`;
    $("previewZoomOutput").textContent = `${Math.round(state.previewZoom * 100)}%`;
  }

  updateColorModeControls();
  updateReadiness();
})();
