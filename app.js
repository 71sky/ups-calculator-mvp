"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const fields = [
    "network", "threePhaseLoad", "activeW",
    "inductiveW", "minutes", "reservePct"
  ];
  let catalog = null;
  let lastResult = null;

  function number(value, digits = 1) {
    return Number(value).toLocaleString("ru-RU", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).replace(/\u00a0|\u202f/g, " ");
  }

  function money(value) {
    return value == null ? "цена по запросу" : `${number(value, 0)} руб`;
  }

  function range(values, unit, digits = 1) {
    if (!values) return "Нет показанных вариантов";
    if (values[0] === values[1]) {
      return `${number(values[0], digits)} ${unit}`;
    }
    return `${number(values[0], digits)}–${number(values[1], digits)} ${unit}`;
  }

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
    catalog = UpsCalc.validateCatalog(raw);
    $("catalog-status").textContent =
      `Каталог загружен. Доступно ИБП ${catalog.ups.length}, АКБ ${catalog.batteries.length}.`;
    $("manual-catalog").hidden = true;
    $("calculate").disabled = false;
    $("reservePct").value = catalog.params.powerReservePct;

    messages($("catalog-check"), [
      `Ошибочных записей ${catalog.invalidRecords}. Отключённых записей ${catalog.disabledRecords}.`,
      ...catalog.errors.map(item =>
        `Ошибка. ${item.sku}. ${item.message}`),
      ...catalog.warnings.map(item =>
        `Предупреждение. ${item.sku}. ${item.message}`)
    ]);

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

  function clearResult() {
    lastResult = null;
    $("results").hidden = true;
  }

  $("network").addEventListener("change", () => {
    const three = $("network").value === "3";
    $("threePhaseLoad").disabled = !three;
    if (!three) $("threePhaseLoad").value = "no";
    clearResult();
  });

  $("form").addEventListener("input", clearResult);
  $("form").addEventListener("change", clearResult);

  function readNumber(id, emptyValue = NaN) {
    const text = $(id).value.trim();
    return text === "" ? emptyValue : Number(text);
  }

  function readInput() {
    return {
      network: Number($("network").value),
      threePhaseLoad: $("threePhaseLoad").value === "yes",
      activeW: readNumber("activeW"),
      inductiveW: readNumber("inductiveW", 0),
      minutes: readNumber("minutes"),
      reservePct: readNumber("reservePct")
    };
  }

  function showErrors(errors) {
    fields.forEach(id => {
      $("error-" + id).textContent = errors[id] ?? "";
      $(id).setAttribute("aria-invalid", errors[id] ? "true" : "false");
    });

    $("input-errors").replaceChildren();
    const entries = Object.entries(errors);
    $("input-errors").hidden = !entries.length;

    entries.forEach(([, text]) => {
      $("input-errors").append(element("p", text));
    });
    if (entries.length) $(entries[0][0]).focus();
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
      ["Требуемая энергия АКБ, ориентировочная ёмкость",
        `${number(r.requiredEnergyKwh, 2)} кВт·ч`],
      ["Пиковая полная мощность", `${number(r.peakKva, 2)} кВА`],
      ["Рекомендуемая мощность сети по вводному автомату",
        range(r.allocatedKwRange, "кВт") +
        (beyond ? `\n${beyond}` : "")],
      ["Номиналы вводного автомата",
        range(r.breakerRange, "А", 0) +
        (beyond ? `\n${beyond}` : "")],
      ["Ориентировочное время заряда",
        range(r.chargeRangeH, "ч")]
    ];
  }

  function schemeText(candidate) {
    if (candidate.scheme === "single") {
      return "Однофазная группа. N без резервирования";
    }
    if (candidate.scheme === "perphase") {
      return "Пофазно 3 × группа. N без резервирования";
    }
    return candidate.ups.outputPhases === 3
      ? "Трёхфазная группа 3-в-3. N без резервирования"
      : "Трёхфазный ввод, однофазный выход 3-в-1. N без резервирования";
  }

  function batteryType(candidate) {
    if (candidate.ups.builtInEnergyKwh > 0) {
      return candidate.battery ? "Встроенная + внешняя" : "Встроенная";
    }
    return "Внешняя";
  }

  function variantRows(candidate, result) {
    const u = candidate.ups;
    const b = candidate.battery;
    const breaker = candidate.breakerA == null
      ? `Более ${result.maxBreakerA} А, требуется отдельный расчёт`
      : `${candidate.breakerA} А, ${
        result.input.network === 3 ? "трёхполюсный" : "однополюсный"
      }`;

    const rows = [
      ["Статус", candidate.status],
      ["Схема подключения", schemeText(candidate)],
      ["Модель ИБП", candidate.product.model]
    ];

    if (candidate.replacement) {
      rows.push([
        "Расчётная единица ИБП",
        `${u.model}. Далее номиналы и количества приведены для составляющих блоков комплекта`
      ]);
    } else if (u.kitOf) {
      rows.push([
        "Расчётная единица ИБП",
        "Готовый комплект. Далее номиналы и количества приведены для комплектов"
      ]);
    }

    rows.push(
      ["Номинал одной расчётной единицы ИБП",
        `${number(u.ratedKva, 2)} кВА / ${number(u.ratedKw, 2)} кВт`],
      ["Число ИБП",
        `${candidate.N} на группу, всего ${candidate.totalUps}`],
      ["Суммарный номинал",
        `${number(candidate.ratedKva, 2)} кВА / ${number(candidate.ratedKw, 2)} кВт`],
      ["Загрузка группы ИБП",
        `${number(candidate.loadKwPct)} % по кВт / ${number(candidate.loadKvaPct)} % по кВА`],
      ["Тип АКБ", batteryType(candidate)],
      ["Встроенная АКБ",
        u.builtInEnergyKwh > 0
          ? `${number(u.builtInEnergyKwh, 2)} кВт·ч на расчётную единицу ИБП, всего ${number(candidate.builtEnergyKwh, 2)} кВт·ч. Входит в стоимость ИБП`
          : "Нет"],
      ["Внешние АКБ", b ? b.model : "Нет"],
      ["Количество внешних АКБ",
        b
          ? `${candidate.K} на расчётную группу, всего ${candidate.totalBatteries}`
          : "0"],
      ["Полная энергия АКБ",
        `${number(candidate.fullEnergyKwh, 2)} кВт·ч`],
      ["Полезная энергия АКБ",
        `${number(candidate.usefulEnergyKwh, 2)} кВт·ч`],
      ["Расчётная автономия выбранной конфигурации",
        UpsCalc.duration(candidate.runtimeMin)],
      ["Целевая автономия",
        `${number(result.input.minutes, 1)} мин`],
      [candidate.deltaMin >= 0 ? "Запас автономии" : "Дефицит автономии",
        `${number(Math.abs(candidate.deltaMin), 2)} мин / ${number(Math.abs(candidate.deltaPct), 2)} %`],
      ["Ориентировочное время заряда",
        `${number(candidate.chargeMinH)}–${number(candidate.chargeMaxH)} ч`],
      ["Рекомендуемая мощность сети по вводному автомату",
        candidate.allocatedKw == null
          ? "Требуется отдельный расчёт"
          : `${number(candidate.allocatedKw, 2)} кВт`],
      ["Вводной автомат", breaker],
      ["Дата обновления цен", candidate.priceDate]
    );

    return rows;
  }

  function headerRows(candidate) {
    const product = candidate.product;
    const battery = candidate.battery;
    const rows = [
      ["ИБП", product.model],
      ["Цена одного ИБП",
        product.showPrice ? money(product.priceRub) : "цена по запросу"],
      ["Количество ИБП для покупки", `${candidate.productCount} шт`],
      ["Стоимость ИБП", money(candidate.upsCost)],
      ["Внешние АКБ", battery ? battery.model : "Не требуются"]
    ];

    if (battery) {
      rows.push(
        ["Цена одной внешней АКБ",
          battery.showPrice ? money(battery.priceRub) : "цена по запросу"],
        ["Количество внешних АКБ", `${candidate.totalBatteries} шт`]
      );
    }

    rows.push(
      ["Стоимость внешних АКБ", money(candidate.batteryCost)],
      ["Итоговая стоимость конфигурации", money(candidate.totalCost)]
    );
    return rows;
  }

  function resultMessage(result) {
    if (!result.successfulCount) {
      return result.selected.length
        ? "Целевая автономия не достигается либо обязательные ограничения не выполнены. Показаны ближайшие конфигурации, они не являются подходящими."
        : "Подходящих вариантов нет. Проверьте причины отказа.";
    }
    if (result.mode === "unpriced") {
      return "Подходящих конфигураций с известной итоговой ценой нет. Показан вариант Б с максимальной автономией. Вариант А и ограничение стоимости определить невозможно.";
    }

    return `Вариант А выбирается по минимальной стоимости. Для варианта Б предел известной итоговой стоимости составляет ${money(result.priceLimitRub)} – не выше 170 % стоимости А. Конфигурации без цены участвуют в выборе Б без проверки этого ограничения.`;
  }

  function addLink(parent, url) {
    if (!url) {
      parent.append(element("p", "Ссылка на модель ИБП отсутствует.", "muted"));
      return;
    }
    const link = element("a", "Страница модели ИБП");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const paragraph = element("p");
    paragraph.append(link);
    parent.append(paragraph);
  }

  function render(result) {
    $("requirements").replaceChildren();
    const requirementList = element("dl", null, "requirement-grid");
    requirementRows(result).forEach(([title, value]) => {
      metric(requirementList, title, value);
    });
    $("requirements").append(requirementList);

    $("result-message").textContent = resultMessage(result);
    $("variants").replaceChildren();

    result.selected.forEach(candidate => {
      const card = element(
        "article",
        null,
        `card ${candidate.status === "не соответствует" ? "fail" : "pass"}`
      );

      card.append(element("h3", `ИБП "${candidate.product.model}"`, "product-title"));

      const prices = element("dl", null, "price-summary");
      headerRows(candidate).filter(([title]) => title !== "ИБП")
        .forEach(([title, value]) => metric(prices, title, value));
      card.append(prices);

      const badges = element("div", null, "badges");
      candidate.labels.forEach(label => {
        badges.append(element("span", label, "badge"));
      });
      badges.append(element("span", candidate.status, "badge"));
      card.append(badges);

      const details = element("dl");
      variantRows(candidate, result).forEach(([title, value]) => {
        metric(details, title, value);
      });
      card.append(details);
      addLink(card, candidate.product.url);

      const warnings = element("div", null, "warning");
      [
        ...candidate.failures.map(reason =>
          `Причина несоответствия. ${reason}`),
        ...candidate.warnings
      ].forEach(text => {
        warnings.append(element("p", text));
      });
      if (warnings.childNodes.length) card.append(warnings);

      $("variants").append(card);
    });

    messages($("rejection-list"), result.rejections.map(item =>
      `${item.reason}. Моделей ${item.count}.`
    ));
    $("rejection-list").append(element(
      "p",
      "Одна модель может иметь несколько причин отказа. Количества не следует складывать.",
      "muted"
    ));
    $("rejections").open = !result.successfulCount;
    $("copy-status").textContent = "";
    $("copy-fallback").hidden = true;
    $("results").hidden = false;
  }

  $("form").addEventListener("submit", event => {
    event.preventDefault();
    if (!catalog) return;

    try {
      const result = UpsCalc.calculate(catalog, readInput());
      showErrors(result.inputErrors);
      if (Object.keys(result.inputErrors).length) {
        clearResult();
        return;
      }
      lastResult = result;
      render(result);
    } catch (error) {
      clearResult();
      $("input-errors").hidden = false;
      $("input-errors").replaceChildren(
        element("p", `Расчёт не выполнен. ${error.message}`)
      );
    }
  });

  function copyText(result) {
    const input = result.input;
    const lines = [
      "Подбор ИБП и LFP АКБ",
      "",
      "Исходные данные",
      `Сеть – ${input.network === 3 ? "трёхфазная" : "однофазная"}`,
      `Трёхфазные потребители – ${input.threePhaseLoad ? "есть" : "нет"}`,
      `Активная нагрузка – ${input.activeW} Вт`,
      `Индуктивная нагрузка – ${input.inductiveW} Вт`,
      `Целевая автономия – ${input.minutes} мин`,
      `Запас мощности – ${input.reservePct} %`,
      "",
      "Требования к системе"
    ];

    requirementRows(result).forEach(([title, value]) => {
      lines.push(`${title} – ${value}`);
    });
    lines.push("", resultMessage(result));

    result.selected.forEach((candidate, index) => {
      lines.push("", `Конфигурация ${index + 1}`, candidate.labels.join(", "));
      headerRows(candidate).forEach(([title, value]) => {
        lines.push(`${title} – ${value}`);
      });
      variantRows(candidate, result).forEach(([title, value]) => {
        lines.push(`${title} – ${value}`);
      });
      lines.push(
        `Ссылка на модель ИБП – ${candidate.product.url || "не указана"}`
      );
      candidate.failures.forEach(text => {
        lines.push(`Причина несоответствия – ${text}`);
      });
      candidate.warnings.forEach(text => {
        lines.push(`Предупреждение – ${text}`);
      });
    });

    lines.push(
      "",
      "Предварительный расчёт. Не заменяет проектирование и подтверждение характеристик производителем."
    );
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
      $("copy-status").textContent =
        "Скопируйте выделенный текст вручную.";
    }
  });
})();
