"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const fields = [
    "network", "voltage", "threePhaseLoad", "activeW",
    "inductiveW", "minutes", "reservePct", "chargeA", "budgetRub"
  ];
  let catalog = null;
  let lastResult = null;
  const number = (value, digits = 1) =>
    Number(value).toLocaleString("ru-RU", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    }).replace(/\u00a0|\u202f/g, " ");
  const money = value => value == null ? "цена по запросу" : `${number(value, 0)} руб`;
  const range = (value, unit, digits = 1) => {
    if (!value) return "Нет показанных вариантов";
    return value[0] === value[1]
      ? `${number(value[0], digits)} ${unit}`
      : `${number(value[0], digits)}–${number(value[1], digits)} ${unit}`;
  };
  const typeName = type => ({
    builtin: "Встроенная",
    external: "Внешняя",
    "builtin+external": "Встроенная + внешняя"
  }[type]);
  const topologyName = type => ({
    "line-interactive": "Линейно-интерактивная",
    "double-conversion": "Двойное преобразование"
  }[type]);

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function metric(parent, title, value) {
    const row = element("div", null, "metric");
    row.append(element("dt", title), element("dd", value));
    parent.append(row);
  }
  function messages(parent, entries) {
    parent.replaceChildren();
    if (!entries.length) {
      parent.append(element("p", "Замечаний нет."));
      return;
    }
    entries.forEach(text => parent.append(element("p", text)));
  }

  function acceptCatalog(raw) {
    const validated = UpsCalc.validateCatalog(raw);
    catalog = validated;
    $("catalog-status").textContent =
      `${catalog.meta.catalogName}. Версия ${catalog.meta.version}. ` +
      `Доступно ИБП ${catalog.ups.length}, АКБ ${catalog.batteries.length}.`;
    $("manual-catalog").hidden = false;
    $("calculate").disabled = false;
    $("reservePct").value = catalog.params.powerReservePct;
    $("chargeA").value = catalog.params.defaultChargeCurrentA;
    const check = [
      `Ошибочных записей ${catalog.invalidRecords}. Отключённых записей ${catalog.disabledRecords}.`,
      ...catalog.errors.map(e => `Ошибка. ${e.sku}. ${e.message}`),
      ...catalog.warnings.map(e => `Предупреждение. ${e.sku}. ${e.message}`)
    ];
    messages($("catalog-check"), check);
    lastResult = null;
    $("results").hidden = true;
  }

  function catalogFailure(error) {
    catalog = null;
    lastResult = null;
    $("calculate").disabled = true;
    $("results").hidden = true;
    $("catalog-status").textContent =
      `Каталог не загрузился. ${error.message} Выберите catalog.json вручную.`;
    $("manual-catalog").hidden = false;
  }

  fetch("catalog.json", { cache: "no-store" })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}.`);
      return response.text();
    })
    .then(text => acceptCatalog(UpsCalc.parseCatalog(text)))
    .catch(catalogFailure);

  $("catalog-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      acceptCatalog(UpsCalc.parseCatalog(await file.text()));
    } catch (error) {
      catalogFailure(error);
    }
  });

  $("network").addEventListener("change", () => {
    const three = $("network").value === "3";
    $("voltage").value = three ? 400 : 230;
    $("threePhaseLoad").disabled = !three;
    if (!three) $("threePhaseLoad").value = "no";
  });

  $("form").addEventListener("input", () => {
    if (lastResult) {
      lastResult = null;
      $("results").hidden = true;
    }
  });

  function readNumber(id, emptyValue = NaN) {
    const value = $(id).value.trim();
    return value === "" ? emptyValue : Number(value);
  }

  function input() {
    return {
      network: Number($("network").value),
      voltage: readNumber("voltage"),
      threePhaseLoad: $("threePhaseLoad").value === "yes",
      activeW: readNumber("activeW"),
      inductiveW: readNumber("inductiveW", 0),
      minutes: readNumber("minutes"),
      reservePct: readNumber("reservePct"),
      chargeA: readNumber("chargeA"),
      budgetRub: readNumber("budgetRub", null)
    };
  }

  function showErrors(errors) {
    fields.forEach(id => {
      $("error-" + id).textContent = errors[id] ?? "";
      $(id).setAttribute("aria-invalid", errors[id] ? "true" : "false");
    });
    $("input-errors").replaceChildren();
    const values = Object.values(errors);
    $("input-errors").hidden = !values.length;
    values.forEach(text => $("input-errors").append(element("p", text)));
    if (values.length) $(Object.keys(errors)[0]).focus();
  }

  function requirementRows(result) {
    const r = result.requirements;
    const beyond = r.breakerAboveRange
      ? `Есть вариант более ${result.maxBreakerA} А, требуется отдельный расчёт`
      : "";
    return [
      ["Нагрузка P", `${number(r.P, 0)} Вт`],
      ["Полная мощность S", `${number(r.S, 0)} ВА`],
      ["Требуемая мощность ИБП", `${number(r.requiredKw, 2)} кВт`],
      ["Требуемый номинал ИБП", `${number(r.requiredKva, 2)} кВА`],
      ["Требуемая энергия АКБ, ориентировочная ёмкость", `${number(r.requiredEnergyKwh, 2)} кВт·ч`],
      ["Пиковая полная мощность", `${number(r.peakKva, 2)} кВА`],
      ["Выделенная мощность по автоматам показанных вариантов",
        range(r.allocatedKwRange, "кВт") + (beyond ? `\n${beyond}` : "")],
      ["Номиналы вводного автомата",
        range(r.breakerRange, "А", 0) + (beyond ? `\n${beyond}` : "")],
      ["Ориентировочное время заряда", range(r.chargeRangeH, "ч")]
    ];
  }

  function variantRows(v, result) {
    const u = v.ups;
    const b = v.battery;
    const scheme = v.scheme === "single" ? "Однофазная группа" :
      v.scheme === "three"
        ? `Трёхфазный ввод, ${u.outputPhases === 3 ? "трёхфазный" : "однофазный"} выход`
        : "Пофазно 3 × группа";
    let batteryScheme = "Внешних АКБ нет";
    if (b) {
      batteryScheme = v.sharedBank
        ? `${v.totalBatteries} параллельно, общий банк на ${v.totalUps} ИБП. Расчётный эквивалент ${v.K} АКБ на фазу`
        : v.groups === 3
          ? `На каждой фазе ${v.K} параллельно, отдельный банк на ${v.N} ИБП`
          : `${v.K} параллельно, общий банк на ${v.N} ИБП`;
    }
    const breaker = v.breakerA == null
      ? `Более ${result.maxBreakerA} А, требуется отдельный расчёт`
      : `${v.breakerA} А, ${result.input.network === 3 ? "трёхполюсный" : "однополюсный"}`;
    const rows = [
      ["Статус", v.status],
      ["Схема", `${scheme}. N без резервирования`],
      ["Оборудование", `Coway. ${v.product.series}. ${v.product.model}\nSKU ${v.product.sku}`],
      ["Количество товарных позиций ИБП", `${v.productCount} шт`],
      ["Расчётный блок ИБП", `${u.model}\nSKU ${u.sku}`],
      ["Топология", topologyName(u.topology)],
      ["Номинал одного расчётного блока", `${number(u.ratedKva, 2)} кВА / ${number(u.ratedKw, 2)} кВт`],
      ["ИБП в расчёте", `${v.N} на группу, всего ${v.totalUps}`],
      ["Суммарный номинал", `${number(v.ratedKva, 2)} кВА / ${number(v.ratedKw, 2)} кВт`],
      ["Загрузка группы", `${number(v.loadKwPct)} % по кВт / ${number(v.loadKvaPct)} % по кВА`],
      ["Тип АКБ", typeName(u.batteryType)],
      ["Встроенная АКБ", u.builtInEnergyKwh > 0
        ? `${number(u.builtInEnergyKwh, 2)} кВт·ч на расчётный блок, всего ${number(v.builtEnergyKwh, 2)} кВт·ч. Входит в стоимость ИБП`
        : "Нет"],
      ["Внешняя АКБ", b ? `Coway. ${b.model}\nSKU ${b.sku}. Химия ${b.chemistry}` : "Нет"],
      ["Количество внешних АКБ", `${v.K} на расчётную группу, всего ${v.totalBatteries}`],
      ["Схема АКБ", batteryScheme],
      ["Полная энергия всех АКБ", `${number(v.fullEnergyKwh, 2)} кВт·ч`],
      ["Полезная энергия всех АКБ", `${number(v.usefulEnergyKwh, 2)} кВт·ч`],
      ["Расчётная автономия выбранной конфигурации", UpsCalc.duration(v.runtimeMin)],
      ["Целевая автономия", `${number(result.input.minutes, 1)} мин`],
      [v.deltaMin >= 0 ? "Запас автономии" : "Дефицит автономии",
        `${number(Math.abs(v.deltaMin), 2)} мин / ${number(Math.abs(v.deltaPct), 2)} %`],
      ["Ток заряда", `${number(v.chargeA)} А на расчётный ИБП, суммарно ${number(v.chargeA * v.totalUps)} А`],
      ["Ориентировочное время заряда", `${number(v.chargeMinH)}–${number(v.chargeMaxH)} ч`],
      ["Расчётная мощность на вводе", `${number(v.inputKw, 2)} кВт`],
      ["Расчётный ток на вводе", `${number(v.inputA, 2)} А${result.input.network === 3 ? " на фазу" : ""}`],
      ["Вводной автомат", breaker],
      ["Требуемая выделенная мощность по автомату",
        v.allocatedKw == null ? "Требуется отдельный расчёт" : `${number(v.allocatedKw, 2)} кВт`],
      ["Стоимость ИБП", money(v.upsCost)],
      ["Стоимость внешних АКБ", money(v.batteryCost)],
      ["Итоговая стоимость", money(v.totalCost)],
      ["Дата цен", v.priceDate]
    ];
    if (u.kitOf) {
      rows.splice(4, 0, ["Состав комплекта",
        `${u.kitOf.count} × ${u.kitOf.sku} на товарную позицию. Число расчётных блоков выше относится к комплектам`]);
    }
    if (v.dischargeA != null) {
      rows.push(["Расчётный ток разряда банка группы", `${number(v.dischargeA, 2)} А`]);
    }
    if (u.formFactor) rows.push(["Исполнение ИБП", u.formFactor]);
    if (u.dimensionsMm) rows.push(["Габариты ИБП, мм", u.dimensionsMm]);
    if (u.weightKg) rows.push(["Масса ИБП, кг", String(u.weightKg)]);
    if (u.interfaces) rows.push(["Интерфейсы ИБП", u.interfaces]);
    if (u.notes) rows.push(["Примечание", u.notes]);
    return rows;
  }

  function addLink(parent, url, title) {
    if (!url) {
      parent.append(element("p", `${title}. Ссылка отсутствует.`));
      return;
    }
    const link = element("a", title);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const paragraph = element("p");
    paragraph.append(link);
    parent.append(paragraph);
  }

  function render(result) {
    $("requirements").replaceChildren();
    const dl = element("dl", null, "requirement-grid");
    requirementRows(result).forEach(([title, value]) => metric(dl, title, value));
    $("requirements").append(dl);
    $("requirements").append(element("p",
      "Общая требуемая энергия рассчитана с КПД и DoD по умолчанию. В карточках применяются характеристики выбранной модели.",
      "muted"));

    $("result-message").textContent = result.successfulCount
      ? `Подходящих конфигураций ${result.successfulCount}. Показано ${result.selected.length}.`
      : result.selected.length
        ? "Целевая автономия не достигается либо конфигурации не проходят обязательные ограничения. Показаны ближайшие варианты, их нельзя считать подходящими."
        : "Подходящих вариантов нет. Проверьте причины отказа.";

    $("variants").replaceChildren();
    result.selected.forEach((v, index) => {
      const card = element("article", null, `card ${v.status === "не соответствует" ? "fail" : "pass"}`);
      card.append(element("h3", `Вариант ${index + 1}`));
      const badges = element("div", null, "badges");
      v.labels.forEach(label => badges.append(element("span", label, "badge")));
      card.append(badges);
      const details = element("dl");
      variantRows(v, result).forEach(([title, value]) => metric(details, title, value));
      card.append(details);
      addLink(card, v.product.url, "Страница ИБП");
      if (v.battery) addLink(card, v.battery.url, "Страница внешней АКБ");
      const warnings = element("div", null, "warning");
      [...v.failures.map(text => `Причина несоответствия. ${text}`), ...v.warnings]
        .forEach(text => warnings.append(element("p", text)));
      if (warnings.childNodes.length) card.append(warnings);
      $("variants").append(card);
    });
    messages($("rejection-list"), result.rejections.map(r => `${r.reason}. Моделей ${r.count}.`));
    $("rejection-list").append(element("p",
      "Количество считается по уникальным SKU внутри каждой причины. Одна модель может иметь несколько причин; числа не следует складывать.",
      "muted"));
    $("rejections").open = !result.successfulCount;
    $("copy-status").textContent = "";
    $("copy-fallback").hidden = true;
    $("results").hidden = false;
  }

  $("form").addEventListener("submit", event => {
    event.preventDefault();
    if (!catalog) return;
    const result = UpsCalc.calculate(catalog, input());
    showErrors(result.inputErrors);
    if (Object.keys(result.inputErrors).length) {
      $("results").hidden = true;
      lastResult = null;
      return;
    }
    lastResult = result;
    render(result);
  });

  function copyText(result) {
    const x = result.input;
    const lines = [
      "Подбор ИБП и LFP АКБ",
      `${catalog.meta.catalogName}. Версия ${catalog.meta.version}`,
      "",
      "Исходные данные",
      `Сеть ${x.network === 3 ? "трёхфазная" : "однофазная"}, напряжение ${x.voltage} В`,
      `Трёхфазные потребители ${x.threePhaseLoad ? "есть" : "нет"}`,
      `Активная нагрузка ${x.activeW} Вт`,
      `Индуктивная нагрузка ${x.inductiveW} Вт`,
      `Целевая автономия ${x.minutes} мин`,
      `Запас мощности ${x.reservePct} %`,
      `Ток заряда ${x.chargeA} А на ИБП`,
      `Бюджет ${x.budgetRub == null ? "без ограничения" : money(x.budgetRub)}`,
      "",
      "Требования к системе"
    ];
    requirementRows(result).forEach(([title, value]) => lines.push(`${title} – ${value}`));
    lines.push("", $("result-message").textContent);
    result.selected.forEach((v, i) => {
      lines.push("", `Вариант ${i + 1}`, v.labels.join(", "));
      variantRows(v, result).forEach(([title, value]) => lines.push(`${title} – ${value}`));
      lines.push(`Ссылка ИБП – ${v.product.url || "не указана"}`);
      if (v.battery) lines.push(`Ссылка АКБ – ${v.battery.url || "не указана"}`);
      v.failures.forEach(text => lines.push(`Причина несоответствия – ${text}`));
      v.warnings.forEach(text => lines.push(`Предупреждение – ${text}`));
    });
    lines.push("", "Причины отказа и ограничения");
    result.rejections.forEach(r => lines.push(`${r.reason} – моделей ${r.count}`));
    lines.push("", "Предварительный расчёт. Не заменяет проектирование и подтверждение характеристик производителем.");
    return lines.join("\n");
  }

  $("copy").addEventListener("click", async () => {
    if (!lastResult) return;
    const text = copyText(lastResult);
    try {
      if (!navigator.clipboard) throw new Error("Буфер обмена недоступен.");
      await navigator.clipboard.writeText(text);
      $("copy-status").textContent = "Результат скопирован.";
    } catch {
      $("copy-fallback").value = text;
      $("copy-fallback").hidden = false;
      $("copy-fallback").focus();
      $("copy-fallback").select();
      $("copy-status").textContent = "Автоматическое копирование недоступно. Скопируйте выделенный текст вручную.";
    }
  });
})();