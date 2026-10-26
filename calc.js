"use strict";

globalThis.UpsCalc = (() => {
  const finite = x => typeof x === "number" && Number.isFinite(x);
  const positive = x => finite(x) && x > 0;
  const norm = x => String(x ?? "").trim().toLowerCase();
  const EPS = 1e-9;

  function parseCatalog(text) {
    // Убираем только артефакты экранирования из предоставленного текста DOCX.
    return JSON.parse(text.trim().replace(/^\uFEFF/, "")
      .replace(/\\([\[\]_])/g, "$1"));
  }

  function validateCatalog(raw) {
    const errors = [];
    const warnings = [];
    const invalid = new Set();
    const error = (r, message) => {
      invalid.add(r);
      errors.push({ sku: String(r.sku || "без SKU"), message });
    };
    const warn = (r, message) =>
      warnings.push({ sku: String(r.sku || "без SKU"), message });

    if (!raw || !Array.isArray(raw.ups) || !Array.isArray(raw.batteries) ||
        !raw.params || !raw.meta) {
      throw new Error("Нужны разделы meta, params, ups и batteries.");
    }

    const p = raw.params;
    const ranges = {
      cosPhiMain: [0.01, 1],
      cosPhiInductive: [0.01, 1],
      inrushFactor: [1, 100],
      powerReservePct: [0, 100],
      defaultDodPct: [50, 100],
      defaultEfficiencyPct: [1, 100],
      defaultChargeCurrentA: [0.001, 100000],
      chargerEfficiencyPct: [1, 100],
      chargeTailFactor: [1, 100],
      inputPF: [0.01, 1],
      breakerReserveFactor: [1, 100],
      agingReservePct: [0, 1000],
      statusReserveThresholdPct: [0, 1000],
      energyCheckTolerancePct: [0, 100],
      phaseUnbalanceFactor: [1, 3]
    };
    Object.entries(ranges).forEach(([key, [min, max]]) => {
      if (!finite(p[key]) || p[key] < min || p[key] > max) {
        throw new Error(`Некорректный параметр ${key}. Диапазон ${min}–${max}.`);
      }
    });
    [
      "recommendedCapacityMandatory", "recommendedCapacityForSingleUps",
      "growUpsCountForBuiltInEnergy", "replaceGroupWithKit",
      "allowSinglePhaseUpsPerPhase"
    ].forEach(key => {
      if (typeof p[key] !== "boolean") {
        throw new Error(`Параметр ${key} должен быть true или false.`);
      }
    });
    if (p.maxChargeTimeH != null && !positive(p.maxChargeTimeH)) {
      throw new Error("maxChargeTimeH должен быть null или больше 0.");
    }
    if (!Array.isArray(p.breakerSeriesA) || !p.breakerSeriesA.length ||
        !p.breakerSeriesA.every(positive)) {
      throw new Error("Некорректный ряд номиналов автоматов.");
    }
    if (raw.meta.currency !== "RUB") {
      throw new Error("Калькулятор поддерживает цены в RUB.");
    }
    const validDate = value => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(value + "T00:00:00Z");
      return Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
    };
    if (!validDate(raw.meta.defaultPriceDate)) {
      throw new Error("Некорректная дата цен по умолчанию.");
    }

    const clean = (list, kind) => list.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Запись ${index + 1} в ${kind} должна быть объектом.`);
      }
      const r = { ...item };
      Object.keys(r).forEach(key => {
        if (typeof r[key] === "string") r[key] = r[key].trim();
      });
      if (r.kitOf && typeof r.kitOf === "object") {
        r.kitOf = { ...r.kitOf, sku: String(r.kitOf.sku ?? "").trim() };
      }
      r.kind = kind;
      r.order = kind === "ups" ? index : raw.ups.length + index;
      return r;
    });

    const ups = clean(raw.ups, "ups");
    const batteries = clean(raw.batteries, "batteries");
    const rows = [...ups, ...batteries];
    const frequencies = new Map();
    rows.forEach(r => frequencies.set(r.sku, (frequencies.get(r.sku) || 0) + 1));

    rows.forEach(r => {
      ["sku", "model", "series"].forEach(key => {
        if (typeof r[key] !== "string" || !r[key]) error(r, `Пустое поле ${key}.`);
      });
      if (frequencies.get(r.sku) > 1) error(r, "Повтор SKU.");
      ["enabled", "showPrice"].forEach(key => {
        if (typeof r[key] !== "boolean") error(r, `${key} должен быть true или false.`);
      });
      if (r.showPrice && (!finite(r.priceRub) || r.priceRub < 0)) {
        error(r, "Нет корректной цены при showPrice = true.");
      }
      if (r.priceDate != null && !validDate(r.priceDate)) error(r, "Некорректная дата цены.");
      if (!r.url) warn(r, "Не указана ссылка.");
      else {
        try {
          if (!["http:", "https:"].includes(new URL(r.url).protocol)) {
            error(r, "Ссылка должна использовать http или https.");
          }
        } catch {
          error(r, "Некорректная ссылка.");
        }
      }
      if (r.verify) warn(r, r.verify);
      if (r.dodPct != null && (!finite(r.dodPct) || r.dodPct < 50 || r.dodPct > 100)) {
        error(r, "DoD вне диапазона 50–100 %.");
      }

      if (r.kind === "ups") {
        if (!positive(r.ratedKw) || !positive(r.ratedKva)) error(r, "кВт и кВА должны быть больше 0.");
        if (!positive(r.outputPF) || r.outputPF > 1) error(r, "Некорректный выходной PF.");
        if (positive(r.ratedKw) && positive(r.ratedKva) && positive(r.outputPF) &&
            Math.abs(r.ratedKw - r.ratedKva * r.outputPF) / r.ratedKw > 0.02) {
          warn(r, "кВт отличается от кВА × PF больше чем на 2 %.");
        }
        if (!["builtin", "external", "builtin+external"].includes(r.batteryType)) {
          error(r, "Неизвестный тип АКБ.");
        }
        if (!["line-interactive", "double-conversion"].includes(r.topology)) {
          error(r, "Неизвестная топология.");
        }
        if (![1, 3].includes(r.inputPhases) || ![1, 3].includes(r.outputPhases)) {
          error(r, "Фазность должна быть 1 или 3.");
        }
        if (!Number.isInteger(r.maxParallel) || r.maxParallel < 1) {
          error(r, "maxParallel должен быть целым и не меньше 1.");
        }
        if (typeof r.allowPerPhase !== "boolean") error(r, "allowPerPhase должен быть логическим.");
        if (r.batteryType !== "external" && !positive(r.builtInEnergyKwh)) {
          error(r, "Нет положительной энергии встроенной АКБ.");
        }
        if (r.batteryType === "external" && r.builtInEnergyKwh !== 0) {
          error(r, "Для внешней АКБ builtInEnergyKwh должен быть 0.");
        }
        if (r.batteryType !== "builtin" &&
            (!norm(r.compatibleBatterySeries) ||
             !Number.isInteger(r.maxExternalBatteriesPerUps) ||
             r.maxExternalBatteriesPerUps < 1)) {
          error(r, "Нет серии совместимых АКБ или положительного предела внешних АКБ.");
        }
        if (r.efficiencyPct != null &&
            (!positive(r.efficiencyPct) || r.efficiencyPct > 100)) {
          error(r, "КПД вне диапазона больше 0 и до 100 %.");
        }
        if (!positive(r.batteryVoltageV)) warn(r, "Не указано напряжение АКБ.");
        if (r.maxChargeCurrentA != null && !positive(r.maxChargeCurrentA)) {
          error(r, "Максимальный ток заряда должен быть больше 0.");
        }
        if (r.recommendedAhPerUpsInParallel != null &&
            !positive(r.recommendedAhPerUpsInParallel)) {
          error(r, "Рекомендуемая ёмкость должна быть больше 0.");
        }
        if (r.overloadPct != null && !positive(r.overloadPct)) error(r, "Некорректная перегрузка.");
        if (r.overloadSec != null && !positive(r.overloadSec)) error(r, "Некорректная длительность перегрузки.");
        if (r.kitOf) {
          if (!r.kitOf.sku || !Number.isInteger(r.kitOf.count) || r.kitOf.count < 2) {
            error(r, "Некорректный состав комплекта.");
          }
        }
      } else {
        if (!positive(r.energyKwh)) error(r, "Энергия АКБ должна быть больше 0.");
        if (r.chemistry !== "LFP") error(r, "Поддерживаются только АКБ LFP.");
        if (!positive(r.voltageV)) warn(r, "Не указано напряжение АКБ.");
        if (r.capacityAh != null && !positive(r.capacityAh)) error(r, "Ёмкость А·ч должна быть больше 0.");
        if (r.maxDischargeA == null) warn(r, "Не указан максимальный ток разряда.");
        else if (!positive(r.maxDischargeA)) error(r, "Максимальный ток разряда должен быть больше 0.");
        if (positive(r.voltageV) && positive(r.capacityAh) && positive(r.energyKwh)) {
          const calculated = r.voltageV * r.capacityAh / 1000;
          if (Math.abs(calculated - r.energyKwh) / r.energyKwh * 100 >
              p.energyCheckTolerancePct + EPS) {
            warn(r, "В × А·ч отличается от указанной энергии больше допустимого порога.");
          }
        }
      }
    });

    const bySku = new Map(ups.map(r => [r.sku, r]));
    ups.forEach(r => {
      if (!r.kitOf) return;
      const visited = new Set([r.sku]);
      let current = r;
      while (current.kitOf) {
        const base = bySku.get(current.kitOf.sku);
        if (!base) {
          error(r, "В комплекте указан отсутствующий SKU ИБП.");
          break;
        }
        if (visited.has(base.sku)) {
          error(r, "Циклический состав комплекта.");
          break;
        }
        visited.add(base.sku);
        current = base;
      }
    });

    // Исключаем также комплекты, ссылающиеся на ошибочные записи.
    let changed;
    do {
      changed = false;
      ups.forEach(r => {
        if (r.kitOf && !invalid.has(r) && invalid.has(bySku.get(r.kitOf.sku))) {
          error(r, "Комплект ссылается на ошибочную запись.");
          changed = true;
        }
      });
    } while (changed);

    const goodBatteries = batteries.filter(r => !invalid.has(r) && r.enabled);
    const compatible = (u, b) =>
      norm(u.compatibleBatterySeries) === norm(b.series) &&
      positive(u.batteryVoltageV) && positive(b.voltageV) &&
      Math.abs(u.batteryVoltageV - b.voltageV) < 0.01;

    ups.filter(r => !invalid.has(r) && r.batteryType !== "builtin").forEach(r => {
      if (!goodBatteries.some(b => compatible(r, b))) {
        warn(r, "Нет используемой совместимой АКБ с совпадающим напряжением.");
      }
    });

    return {
      meta: { ...raw.meta },
      params: { ...p, breakerSeriesA: [...new Set(p.breakerSeriesA)].sort((a, b) => a - b) },
      ups: ups.filter(r => !invalid.has(r) && r.enabled),
      batteries: goodBatteries,
      errors,
      warnings,
      invalidRecords: invalid.size,
      disabledRecords: rows.filter(r => !invalid.has(r) && !r.enabled).length
    };
  }

  function validateInput(x) {
    const errors = {};
    if (![1, 3].includes(x.network)) errors.network = "Выберите однофазную или трёхфазную сеть.";
    if (!finite(x.voltage) || x.voltage < 100 || x.voltage > 500) {
      errors.voltage = "Напряжение сети от 100 до 500 В.";
    }
    if (!finite(x.activeW)) errors.activeW = "Введите активную нагрузку, можно 0.";
    else if (x.activeW < 0) errors.activeW = "Нагрузка не может быть отрицательной.";
    if (!finite(x.inductiveW) || x.inductiveW < 0) errors.inductiveW = "Нагрузка не может быть отрицательной.";
    if (finite(x.activeW) && finite(x.inductiveW) && x.activeW + x.inductiveW <= 0) {
      errors.activeW = "Суммарная нагрузка должна быть больше 0.";
    }
    if (!positive(x.minutes)) errors.minutes = "Время автономии должно быть больше 0.";
    if (!finite(x.reservePct) || x.reservePct < 0 || x.reservePct > 100) {
      errors.reservePct = "Запас мощности от 0 до 100 %.";
    }
    if (!positive(x.chargeA)) errors.chargeA = "Ток заряда должен быть больше 0.";
    if (x.budgetRub != null && !positive(x.budgetRub)) errors.budgetRub = "Бюджет должен быть больше 0.";
    if (x.network === 1 && x.threePhaseLoad) {
      errors.threePhaseLoad = "Трёхфазные потребители невозможны при однофазной сети.";
    }
    return errors;
  }

  function duration(minutes) {
    const m = Math.max(0, minutes);
    if (m <= 60) return `${Math.floor(m + EPS)} мин`;
    const rounded = Math.floor((m + EPS) / 10) * 10;
    return `${Math.floor(rounded / 60)} ч ${String(rounded % 60).padStart(2, "0")} мин`;
  }

  function calculate(catalog, input) {
    const inputErrors = validateInput(input);
    if (Object.keys(inputErrors).length) return { inputErrors };

    const p = catalog.params;
    const P = input.activeW + input.inductiveW;
    const S = input.activeW / p.cosPhiMain + input.inductiveW / p.cosPhiInductive;
    const peak = input.activeW / p.cosPhiMain +
      input.inductiveW / p.cosPhiInductive * p.inrushFactor;
    const reserve = 1 + input.reservePct / 100;
    const aging = 1 + p.agingReservePct / 100;
    const defaultEta = p.defaultEfficiencyPct / 100;
    const defaultDod = p.defaultDodPct / 100;
    const requirements = {
      P, S, requiredKw: P * reserve / 1000,
      requiredKva: S * reserve / 1000,
      requiredEnergyKwh: P * input.minutes / 60 / defaultEta / defaultDod * aging / 1000,
      peakKva: peak / 1000
    };
    const rejected = new Map();
    const reject = (reason, sku) => {
      if (!rejected.has(reason)) rejected.set(reason, new Set());
      rejected.get(reason).add(sku);
    };
    catalog.errors.forEach(e => reject("Ошибка в данных каталога", e.sku));
    const candidates = [];

    function schemes(u) {
      if (input.network === 1) {
        return u.inputPhases === 1 && u.outputPhases === 1 ? ["single"] : [];
      }
      const result = [];
      if (u.inputPhases === 3 &&
          (u.outputPhases === 3 || (!input.threePhaseLoad && u.outputPhases === 1))) {
        result.push("three");
      }
      if (u.inputPhases === 1 && u.outputPhases === 1 &&
          u.allowPerPhase && p.allowSinglePhaseUpsPerPhase) {
        result.push("perphase");
      }
      return result;
    }

    function composition(u, count) {
      let current = u;
      let total = count;
      const visited = new Set();
      while (current.kitOf && !visited.has(current.sku)) {
        visited.add(current.sku);
        const base = catalog.ups.find(v => v.sku === current.kitOf.sku);
        if (!base) break;
        total *= current.kitOf.count;
        current = base;
      }
      return `${current.sku}|${total}`;
    }

    function build(u, b, scheme, initialN) {
      const groups = scheme === "perphase" ? 3 : 1;
      const phaseFactor = scheme === "perphase" ? p.phaseUnbalanceFactor / 3 : 1;
      const Pg = P * phaseFactor;
      const Sg = S * phaseFactor;
      const peakG = peak * phaseFactor;
      const eta = (u.efficiencyPct ?? p.defaultEfficiencyPct) / 100;
      const dodU = (u.dodPct ?? p.defaultDodPct) / 100;
      const dodB = b ? (b.dodPct ?? p.defaultDodPct) / 100 : defaultDod;
      const requiredUsefulWh = Pg * input.minutes / 60 / eta * aging;
      let N = initialN;
      const warnings = [];
      const failures = [];
      if (u.efficiencyPct == null) warnings.push("КПД взят из раздела params вместо паспорта.");
      if (u.batteryType !== "external" && u.dodPct == null) {
        warnings.push("DoD встроенной АКБ взят из раздела params.");
      }
      if (scheme === "perphase") {
        warnings.push(`Расчёт на фазу с коэффициентом неравномерности ${p.phaseUnbalanceFactor}.`);
        if (input.threePhaseLoad) {
          warnings.push("Для трёхфазных потребителей требуется синхронная работа ИБП по фазам, подтвердите у производителя.");
        }
      }
      if (input.network === 3 && scheme === "three") {
        warnings.push("Расчёт вводного тока предполагает равномерную трёхфазную нагрузку.");
      }

      if (u.batteryType === "builtin" && p.growUpsCountForBuiltInEnergy) {
        const energyN = Math.ceil((requiredUsefulWh - EPS) /
          (u.builtInEnergyKwh * 1000 * dodU));
        N = Math.min(u.maxParallel, Math.max(N, energyN));
      }

      const builtWh = N * u.builtInEnergyKwh * 1000;
      const builtUsefulWh = builtWh * dodU;
      let K = 0;
      let energyK = 0;
      let currentK = 0;
      let recommendedK = 0;
      let dischargeA = null;
      const Kmax = N * u.maxExternalBatteriesPerUps;

      if (b) {
        energyK = Math.max(u.batteryType === "external" ? 1 : 0,
          Math.ceil((requiredUsefulWh - builtUsefulWh - EPS) /
            (b.energyKwh * 1000 * dodB)));
        if (u.batteryType === "external") {
          dischargeA = Pg / eta / b.voltageV;
          if (positive(b.maxDischargeA)) {
            currentK = Math.ceil((dischargeA - EPS) / b.maxDischargeA);
          } else warnings.push("Ток разряда АКБ не проверен – паспортный предел отсутствует.");
        }

        const applyRecommended = positive(u.recommendedAhPerUpsInParallel) &&
          (N >= 2 || p.recommendedCapacityForSingleUps);
        if (applyRecommended && p.recommendedCapacityMandatory) {
          if (positive(b.capacityAh)) {
            recommendedK = Math.ceil(u.recommendedAhPerUpsInParallel * N / b.capacityAh);
          } else {
            warnings.push("Обязательная рекомендуемая ёмкость не проверена – нет паспортной ёмкости А·ч.");
            failures.push("Не удалось проверить обязательную рекомендуемую ёмкость");
          }
        }
        K = Math.min(Math.max(energyK, currentK, recommendedK), Kmax);
        if (energyK > Kmax) failures.push("Не хватает энергии АКБ даже при максимальном количестве АКБ");
        if (currentK > Kmax) failures.push("Ток разряда больше допустимого");
        if (recommendedK > Kmax) failures.push("Обязательная рекомендуемая ёмкость превышает предел АКБ");

        if (applyRecommended && positive(b.capacityAh) &&
            K * b.capacityAh + EPS < u.recommendedAhPerUpsInParallel * N) {
          warnings.push(`Рекомендуется не менее ${u.recommendedAhPerUpsInParallel * N} А·ч на группу, в конфигурации ${K * b.capacityAh} А·ч.`);
        }
      }

      const usedBattery = K > 0 ? b : null;
      if (usedBattery?.dodPct == null && usedBattery) warnings.push("DoD внешней АКБ взят из раздела params.");
      if (u.batteryType === "builtin+external" && usedBattery) {
        warnings.push("Распределение тока между встроенной и внешней АКБ не проверено.");
      }

      const externalWh = usedBattery ? K * usedBattery.energyKwh * 1000 : 0;
      const usefulWh = builtUsefulWh + externalWh * dodB;
      const fullWh = builtWh + externalWh;
      const runtimeMin = usefulWh * eta / Pg * 60 / aging;
      const deltaMin = runtimeMin - input.minutes;
      const deltaPct = deltaMin / input.minutes * 100;

      if (deltaMin < -EPS && !failures.some(x => x.includes("энергии АКБ"))) {
        failures.push(u.batteryType === "builtin"
          ? "Встроенной АКБ недостаточно, расширение не предусмотрено"
          : "Не хватает энергии АКБ даже при максимальном количестве АКБ");
      }

      if (positive(u.overloadPct)) {
        if (peakG / 1000 > N * u.ratedKva * u.overloadPct / 100 + EPS) {
          warnings.push("Пиковая полная мощность выше заявленной перегрузочной способности. Возможен отказ при пуске.");
        }
        if (input.inductiveW > 0) {
          warnings.push(`Перегрузка ${u.overloadPct} %, допустимая длительность ${u.overloadSec ?? "не указана"} с. Длительность пуска не проверена.`);
        }
      } else if (input.inductiveW > 0) {
        warnings.push("Пусковой ток не проверен – нет паспортной перегрузочной способности.");
      }

      const U = positive(u.batteryVoltageV) ? u.batteryVoltageV : usedBattery?.voltageV;
      if (!positive(U)) {
        reject("Не указано напряжение АКБ, расчёт невозможен", u.sku);
        return;
      }
      const chargeA = Math.min(input.chargeA, u.maxChargeCurrentA ?? input.chargeA);
      if (u.maxChargeCurrentA == null) {
        warnings.push("Паспортный ток заряда не указан, используется значение формы.");
      }
      let bankAh = builtWh / U;
      if (usedBattery) bankAh += K * (usedBattery.capacityAh ?? usedBattery.energyKwh * 1000 / U);
      if (builtWh > 0 || (usedBattery && usedBattery.capacityAh == null)) {
        warnings.push("Для оценки 0,3C часть ёмкости А·ч вычислена из энергии и напряжения.");
      }

      const fastBankA = N * chargeA;
      const slowBankA = Math.min(fastBankA, 0.3 * bankAh);
      const chargeMinH = usefulWh / (U * fastBankA) * p.chargeTailFactor;
      const chargeMaxH = usefulWh / (U * slowBankA) * p.chargeTailFactor;
      if (fastBankA > 0.3 * bankAh + EPS) {
        warnings.push("Быстрая граница заряда предполагает ток выше 0,3C. Допустимость зарядного тока необходимо подтвердить по паспорту АКБ и BMS.");
      }
      warnings.push("Время заряда оценено по полезной энергии. Температура, балансировка и алгоритм BMS не учтены.");

      if (p.maxChargeTimeH != null && chargeMaxH > p.maxChargeTimeH + EPS) {
        reject("Время заряда больше допустимого", u.sku);
        return;
      }

      const inputWGroup = Pg / eta +
        N * U * chargeA / (p.chargerEfficiencyPct / 100);
      const phaseVoltage = input.voltage / Math.sqrt(3);
      const inputA = scheme === "perphase"
        ? inputWGroup / (phaseVoltage * p.inputPF)
        : input.network === 3
          ? inputWGroup / (Math.sqrt(3) * input.voltage * p.inputPF)
          : inputWGroup / (input.voltage * p.inputPF);
      const breakerA = p.breakerSeriesA.find(a =>
        a + EPS >= inputA * p.breakerReserveFactor) ?? null;
      const allocatedKw = breakerA == null ? null :
        (input.network === 3 ? Math.sqrt(3) * input.voltage : input.voltage) * breakerA / 1000;

      let product = u;
      let productCount = N * groups;
      let replacement = false;
      const effectiveOutputPhases = scheme === "perphase" ? 3 : u.outputPhases;
      if (p.replaceGroupWithKit && !usedBattery && productCount > 1) {
        const kit = catalog.ups.find(k =>
          k.kitOf?.sku === u.sku &&
          k.kitOf.count === productCount &&
          k.outputPhases === effectiveOutputPhases &&
          k.inputPhases === input.network &&
          k.batteryType === "builtin");
        if (kit) {
          product = kit;
          productCount = 1;
          replacement = true;
          if (kit.verify) warnings.push(kit.verify);
          warnings.push("Группа заменена готовым комплектом. Электрический расчёт приведён для составляющих блоков.");
        }
      }

      const upsCost = product.showPrice ? product.priceRub * productCount : null;
      const batteryCost = usedBattery
        ? usedBattery.showPrice ? usedBattery.priceRub * K * groups : null
        : 0;
      const totalCost = upsCost == null || batteryCost == null ? null : upsCost + batteryCost;
      if (totalCost == null) warnings.push("Цена скрыта, бюджет не проверен. Вариант не участвует в выборе минимальной стоимости.");
      if (input.budgetRub != null && totalCost != null && totalCost > input.budgetRub + EPS) {
        reject("Превышен бюджет", u.sku);
        return;
      }

      const priceDates = [product.priceDate ?? catalog.meta.defaultPriceDate];
      if (usedBattery) priceDates.push(usedBattery.priceDate ?? catalog.meta.defaultPriceDate);
      const sharedBank = scheme === "perphase" && u.maxParallel > 1 && !!usedBattery;
      if (sharedBank) {
        warnings.push("Предполагается общий банк АКБ на три фазы. Такая DC-схема допустима только после подтверждения производителя.");
      }
      const status = failures.length || deltaMin < -EPS
        ? "не соответствует"
        : deltaPct <= p.statusReserveThresholdPct + EPS ? "соответствует" : "запас";
      failures.forEach(reason => reject(reason, u.sku));

      const key = [
        composition(u, N * groups), effectiveOutputPhases,
        usedBattery?.sku ?? "", K * groups,
        scheme === "perphase" && !sharedBank && usedBattery ? "separate" : "common"
      ].join("|");

      candidates.push({
        key, order: u.order, product, productCount, replacement,
        ups: u, battery: usedBattery, scheme, groups, N, K,
        totalUps: N * groups, totalBatteries: K * groups,
        sharedBank, Pg, Sg, ratedKw: N * groups * u.ratedKw,
        ratedKva: N * groups * u.ratedKva,
        loadKwPct: Pg / (N * u.ratedKw * 1000) * 100,
        loadKvaPct: Sg / (N * u.ratedKva * 1000) * 100,
        builtEnergyKwh: builtWh * groups / 1000,
        fullEnergyKwh: fullWh * groups / 1000,
        usefulEnergyKwh: usefulWh * groups / 1000,
        runtimeMin, deltaMin, deltaPct, status, failures,
        dischargeA, chargeA, chargeMinH, chargeMaxH,
        inputKw: inputWGroup * groups / 1000, inputA,
        breakerA, allocatedKw, upsCost, batteryCost, totalCost,
        priceDate: priceDates.sort()[0],
        warnings: [...new Set(warnings)]
      });
    }

    catalog.ups.forEach(u => {
      const allowed = schemes(u);
      if (!allowed.length) {
        reject("Нет ИБП с подходящей фазностью", u.sku);
        return;
      }
      allowed.forEach(scheme => {
        const phaseFactor = scheme === "perphase" ? p.phaseUnbalanceFactor / 3 : 1;
        const N = Math.max(1, Math.ceil(Math.max(
          P * phaseFactor * reserve / (u.ratedKw * 1000),
          S * phaseFactor * reserve / (u.ratedKva * 1000)
        ) - EPS));
        if (N > u.maxParallel) {
          reject("Не хватает мощности ИБП даже при максимальном числе ИБП в параллели", u.sku);
          return;
        }
        if (u.batteryType === "builtin") {
          build(u, null, scheme, N);
          return;
        }
        const matching = catalog.batteries.filter(b =>
          norm(u.compatibleBatterySeries) === norm(b.series) &&
          positive(u.batteryVoltageV) && positive(b.voltageV) &&
          Math.abs(u.batteryVoltageV - b.voltageV) < 0.01);
        if (u.batteryType === "builtin+external") build(u, null, scheme, N);
        if (!matching.length) reject("Нет совместимой АКБ", u.sku);
        matching.forEach(b => build(u, b, scheme, N));
      });
    });

    const unique = new Map();
    candidates.forEach(v => {
      const old = unique.get(v.key);
      if (!old || (v.replacement && !old.replacement)) unique.set(v.key, v);
    });
    const all = [...unique.values()];
    const successful = all.filter(v => v.status !== "не соответствует");
    const cost = v => v.totalCost == null ? Infinity : v.totalCost;
    const compareCost = (a, b) => {
      const x = cost(a), y = cost(b);
      return x === y ? 0 : x < y ? -1 : 1;
    };
    const tie = (a, b) =>
      b.runtimeMin - a.runtimeMin || compareCost(a, b) || a.order - b.order;
    const selected = [];
    const add = (v, label) => {
      if (!v) return;
      let found = selected.find(x => x.key === v.key);
      if (!found) {
        found = { ...v, labels: [] };
        selected.push(found);
      }
      found.labels.push(label);
    };

    if (successful.length) {
      const priced = successful.filter(v => v.totalCost != null);
      add([...priced].sort((a, b) => compareCost(a, b) || tie(a, b))[0],
        "Минимальная стоимость");
      add([...successful].sort((a, b) =>
        a.totalBatteries - b.totalBatteries || tie(a, b))[0],
        "Минимум внешних АКБ");
      add([...successful].sort(tie)[0], "Максимальный запас автономии");
    } else {
      [...all].sort(tie).slice(0, 3).forEach(v => add(v, "Ближайший по автономии"));
    }

    const range = values => {
      const finiteValues = values.filter(finite);
      return finiteValues.length ? [Math.min(...finiteValues), Math.max(...finiteValues)] : null;
    };
    requirements.allocatedKwRange = range(selected.map(v => v.allocatedKw));
    requirements.breakerRange = range(selected.map(v => v.breakerA));
    requirements.breakerAboveRange = selected.some(v => v.breakerA == null);
    requirements.chargeRangeH = selected.length ? [
      Math.min(...selected.map(v => v.chargeMinH)),
      Math.max(...selected.map(v => v.chargeMaxH))
    ] : null;

    return {
      inputErrors: {}, input, requirements, selected,
      candidateCount: all.length, successfulCount: successful.length,
      maxBreakerA: Math.max(...p.breakerSeriesA),
      rejections: [...rejected].map(([reason, records]) => ({
        reason, count: records.size
      }))
    };
  }

  return { parseCatalog, validateCatalog, validateInput, calculate, duration };
})();