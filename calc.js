"use strict";

globalThis.UpsCalc = (() => {
  const CHARGE_LIMIT_A = 60;
  const EPS = 1e-9;
  const finite = value =>
    typeof value === "number" && Number.isFinite(value);
  const positive = value => finite(value) && value > 0;
  const norm = value => String(value ?? "").trim().toLowerCase();

  function parseCatalog(text) {
    return JSON.parse(
      text.trim().replace(/^\uFEFF/, "").replace(/\\([\[\]_])/g, "$1")
    );
  }

  function validDate(value) {
    if (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value;
  }

  function validateCatalog(raw) {
    if (!raw || !raw.meta || !raw.params ||
        !Array.isArray(raw.ups) || !Array.isArray(raw.batteries)) {
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

    Object.entries(ranges).forEach(([name, limits]) => {
      if (!finite(p[name]) ||
          p[name] < limits[0] || p[name] > limits[1]) {
        throw new Error(`Некорректный параметр ${name}.`);
      }
    });

    [
      "recommendedCapacityMandatory",
      "recommendedCapacityForSingleUps",
      "growUpsCountForBuiltInEnergy",
      "replaceGroupWithKit",
      "allowSinglePhaseUpsPerPhase"
    ].forEach(name => {
      if (typeof p[name] !== "boolean") {
        throw new Error(`Параметр ${name} должен быть true или false.`);
      }
    });

    if (p.maxChargeTimeH != null && !positive(p.maxChargeTimeH)) {
      throw new Error("maxChargeTimeH должен быть null или больше 0.");
    }
    if (!Array.isArray(p.breakerSeriesA) ||
        !p.breakerSeriesA.length ||
        !p.breakerSeriesA.every(positive)) {
      throw new Error("Некорректный ряд номиналов вводного автомата.");
    }
    if (raw.meta.currency !== "RUB") {
      throw new Error("Поддерживаются цены в RUB.");
    }
    if (!validDate(raw.meta.defaultPriceDate)) {
      throw new Error("Некорректная дата цен по умолчанию.");
    }

    const errors = [];
    const warnings = [];
    const invalid = new Set();

    const error = (record, message) => {
      invalid.add(record);
      errors.push({ sku: record.sku || "без SKU", message });
    };
    const warn = (record, message) => {
      warnings.push({ sku: record.sku || "без SKU", message });
    };

    function clean(list, kind) {
      return list.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`Некорректная запись ${index + 1} в ${kind}.`);
        }
        const record = { ...item, kind };
        record.order = kind === "ups" ? index : raw.ups.length + index;
        Object.keys(record).forEach(name => {
          if (typeof record[name] === "string") {
            record[name] = record[name].trim();
          }
        });
        if (record.kitOf && typeof record.kitOf === "object") {
          record.kitOf = {
            ...record.kitOf,
            sku: String(record.kitOf.sku ?? "").trim()
          };
        }
        return record;
      });
    }

    const ups = clean(raw.ups, "ups");
    const batteries = clean(raw.batteries, "batteries");
    const rows = [...ups, ...batteries];
    const frequencies = new Map();

    rows.forEach(record => {
      frequencies.set(record.sku, (frequencies.get(record.sku) || 0) + 1);
    });

    rows.forEach(record => {
      ["sku", "model", "series"].forEach(name => {
        if (typeof record[name] !== "string" || !record[name]) {
          error(record, `Пустое поле ${name}.`);
        }
      });
      if (frequencies.get(record.sku) > 1) error(record, "Повтор SKU.");

      ["enabled", "showPrice"].forEach(name => {
        if (typeof record[name] !== "boolean") {
          error(record, `${name} должен быть true или false.`);
        }
      });

      if (record.showPrice &&
          (!finite(record.priceRub) || record.priceRub < 0)) {
        error(record, "Нет корректной цены при showPrice = true.");
      }
      if (record.priceDate != null && !validDate(record.priceDate)) {
        error(record, "Некорректная дата цены.");
      }

      if (!record.url) {
        warn(record, "Не указана ссылка.");
      } else {
        try {
          const protocol = new URL(record.url).protocol;
          if (!["http:", "https:"].includes(protocol)) {
            error(record, "Некорректный протокол ссылки.");
          }
        } catch {
          error(record, "Некорректная ссылка.");
        }
      }

      if (record.verify) warn(record, record.verify);
      if (record.dodPct != null &&
          (!finite(record.dodPct) ||
           record.dodPct < 50 || record.dodPct > 100)) {
        error(record, "DoD вне диапазона 50–100 %.");
      }

      if (record.kind === "ups") {
        if (!positive(record.ratedKw) || !positive(record.ratedKva)) {
          error(record, "кВт и кВА должны быть больше 0.");
        }
        if (!positive(record.outputPF) || record.outputPF > 1) {
          error(record, "Некорректный выходной PF.");
        }
        if (positive(record.ratedKw) &&
            positive(record.ratedKva) &&
            positive(record.outputPF) &&
            Math.abs(record.ratedKw -
              record.ratedKva * record.outputPF) / record.ratedKw > 0.02) {
          warn(record, "кВт отличается от кВА × PF больше чем на 2 %.");
        }
        if (!["builtin", "external", "builtin+external"]
            .includes(record.batteryType)) {
          error(record, "Неизвестный тип АКБ.");
        }
        if (!["line-interactive", "double-conversion"]
            .includes(record.topology)) {
          error(record, "Неизвестная топология.");
        }
        if (![1, 3].includes(record.inputPhases) ||
            ![1, 3].includes(record.outputPhases)) {
          error(record, "Фазность должна быть 1 или 3.");
        }
        if (!Number.isInteger(record.maxParallel) ||
            record.maxParallel < 1) {
          error(record, "Некорректное максимальное число ИБП.");
        }
        if (typeof record.allowPerPhase !== "boolean") {
          error(record, "allowPerPhase должен быть true или false.");
        }
        if (record.batteryType !== "external" &&
            !positive(record.builtInEnergyKwh)) {
          error(record, "Нет положительной энергии встроенной АКБ.");
        }
        if (record.batteryType === "external" &&
            record.builtInEnergyKwh !== 0) {
          error(record, "Для внешней АКБ встроенная энергия должна быть 0.");
        }
        if (record.batteryType !== "builtin" &&
            (!norm(record.compatibleBatterySeries) ||
             !Number.isInteger(record.maxExternalBatteriesPerUps) ||
             record.maxExternalBatteriesPerUps < 1)) {
          error(record, "Нет серии совместимых АКБ или предела внешних АКБ.");
        }
        if (record.efficiencyPct != null &&
            (!positive(record.efficiencyPct) || record.efficiencyPct > 100)) {
          error(record, "Некорректный КПД.");
        }
        if (!positive(record.batteryVoltageV)) {
          warn(record, "Не указано напряжение АКБ.");
        }
        if (record.maxChargeCurrentA != null &&
            !positive(record.maxChargeCurrentA)) {
          error(record, "Некорректный максимальный ток заряда.");
        }
        if (record.recommendedAhPerUpsInParallel != null &&
            !positive(record.recommendedAhPerUpsInParallel)) {
          error(record, "Некорректная рекомендуемая ёмкость.");
        }
        if (record.overloadPct != null && !positive(record.overloadPct)) {
          error(record, "Некорректная перегрузочная способность.");
        }
        if (record.overloadSec != null && !positive(record.overloadSec)) {
          error(record, "Некорректная длительность перегрузки.");
        }
        if (record.kitOf &&
            (!record.kitOf.sku ||
             !Number.isInteger(record.kitOf.count) ||
             record.kitOf.count < 2)) {
          error(record, "Некорректный состав комплекта.");
        }
      } else {
        if (!positive(record.energyKwh)) {
          error(record, "Энергия АКБ должна быть больше 0.");
        }
        if (record.chemistry !== "LFP") {
          error(record, "Поддерживаются только АКБ LFP.");
        }
        if (!positive(record.voltageV)) {
          warn(record, "Не указано напряжение АКБ.");
        }
        if (record.capacityAh != null && !positive(record.capacityAh)) {
          error(record, "Некорректная ёмкость А·ч.");
        }
        if (record.maxDischargeA == null) {
          warn(record, "Не указан максимальный ток разряда.");
        } else if (!positive(record.maxDischargeA)) {
          error(record, "Некорректный максимальный ток разряда.");
        }
        if (positive(record.voltageV) &&
            positive(record.capacityAh) &&
            positive(record.energyKwh)) {
          const calculated = record.voltageV * record.capacityAh / 1000;
          if (Math.abs(calculated - record.energyKwh) /
              record.energyKwh * 100 >
              p.energyCheckTolerancePct + EPS) {
            warn(record, "В × А·ч отличается от указанной энергии больше порога.");
          }
        }
      }
    });

    const bySku = new Map(ups.map(record => [record.sku, record]));

    ups.forEach(record => {
      if (!record.kitOf || invalid.has(record)) return;
      const visited = new Set([record.sku]);
      let current = record;
      while (current.kitOf) {
        const base = bySku.get(current.kitOf.sku);
        if (!base) {
          error(record, "В комплекте указан отсутствующий SKU ИБП.");
          break;
        }
        if (visited.has(base.sku)) {
          error(record, "Циклический состав комплекта.");
          break;
        }
        visited.add(base.sku);
        current = base;
      }
    });

    let changed;
    do {
      changed = false;
      ups.forEach(record => {
        if (record.kitOf && !invalid.has(record) &&
            invalid.has(bySku.get(record.kitOf.sku))) {
          error(record, "Комплект ссылается на ошибочную запись.");
          changed = true;
        }
      });
    } while (changed);

    const goodUps = ups.filter(record => record.enabled && !invalid.has(record));
    const goodBatteries = batteries.filter(record =>
      record.enabled && !invalid.has(record));

    goodUps.filter(record => record.batteryType !== "builtin")
      .forEach(record => {
        if (!goodBatteries.some(battery => compatible(record, battery))) {
          warn(record, "Нет используемой совместимой АКБ с совпадающим напряжением.");
        }
      });

    return {
      meta: { ...raw.meta },
      params: {
        ...p,
        breakerSeriesA: [...new Set(p.breakerSeriesA)].sort((a, b) => a - b)
      },
      ups: goodUps,
      batteries: goodBatteries,
      errors,
      warnings,
      invalidRecords: invalid.size,
      disabledRecords: rows.filter(record =>
        !invalid.has(record) && !record.enabled).length
    };
  }

  function compatible(ups, battery) {
    return norm(ups.compatibleBatterySeries) === norm(battery.series) &&
      positive(ups.batteryVoltageV) &&
      positive(battery.voltageV) &&
      Math.abs(ups.batteryVoltageV - battery.voltageV) < 0.01;
  }

  function validateInput(input) {
    const errors = {};

    if (![1, 3].includes(input.network)) {
      errors.network = "Выберите тип питающей сети.";
    }
    if (typeof input.threePhaseLoad !== "boolean") {
      errors.threePhaseLoad = "Укажите наличие трёхфазных потребителей.";
    } else if (input.network === 1 && input.threePhaseLoad) {
      errors.threePhaseLoad =
        "Трёхфазные потребители невозможны при однофазной сети.";
    }
    if (!finite(input.activeW)) {
      errors.activeW = "Введите активную нагрузку, можно 0.";
    } else if (input.activeW < 0) {
      errors.activeW = "Нагрузка не может быть отрицательной.";
    }
    if (!finite(input.inductiveW) || input.inductiveW < 0) {
      errors.inductiveW = "Нагрузка не может быть отрицательной.";
    }
    if (finite(input.activeW) && finite(input.inductiveW) &&
        input.activeW + input.inductiveW <= 0) {
      errors.activeW = "Суммарная нагрузка должна быть больше 0.";
    }
    if (!positive(input.minutes)) {
      errors.minutes = "Время автономии должно быть больше 0.";
    }
    if (!finite(input.reservePct) ||
        input.reservePct < 0 || input.reservePct > 100) {
      errors.reservePct = "Запас мощности от 0 до 100 %.";
    }

    return errors;
  }

  function duration(minutes) {
    const value = Math.max(0, minutes);
    if (value <= 60) return `${Math.floor(value + EPS)} мин`;
    const rounded = Math.floor((value + EPS) / 10) * 10;
    return `${Math.floor(rounded / 60)} ч ${
      String(rounded % 60).padStart(2, "0")
    } мин`;
  }

  function calculate(catalog, suppliedInput) {
    const input = {
      network: suppliedInput.network,
      threePhaseLoad: suppliedInput.threePhaseLoad,
      activeW: suppliedInput.activeW,
      inductiveW: suppliedInput.inductiveW,
      minutes: suppliedInput.minutes,
      reservePct: suppliedInput.reservePct,
      voltage: suppliedInput.network === 3 ? 400 : 230
    };
    const inputErrors = validateInput(input);
    if (Object.keys(inputErrors).length) return { inputErrors };

    const p = catalog.params;
    const P = input.activeW + input.inductiveW;
    const S = input.activeW / p.cosPhiMain +
      input.inductiveW / p.cosPhiInductive;
    const peak = input.activeW / p.cosPhiMain +
      input.inductiveW / p.cosPhiInductive * p.inrushFactor;
    const reserve = 1 + input.reservePct / 100;
    const aging = 1 + p.agingReservePct / 100;
    const requirements = {
      P,
      S,
      requiredKw: P * reserve / 1000,
      requiredKva: S * reserve / 1000,
      requiredEnergyKwh: P * input.minutes / 60 /
        (p.defaultEfficiencyPct / 100) /
        (p.defaultDodPct / 100) * aging / 1000,
      peakKva: peak / 1000
    };

    const rejected = new Map();
    const reject = (reason, sku) => {
      if (!rejected.has(reason)) rejected.set(reason, new Set());
      rejected.get(reason).add(sku);
    };
    catalog.errors.forEach(item =>
      reject("Ошибка в данных каталога", item.sku));
    const candidates = [];

    function schemes(ups) {
      if (input.network === 1) {
        return ups.inputPhases === 1 && ups.outputPhases === 1
          ? ["single"] : [];
      }

      const result = [];
      if (ups.inputPhases === 3 &&
          (ups.outputPhases === 3 ||
           (!input.threePhaseLoad && ups.outputPhases === 1))) {
        result.push("three");
      }

      const parallelAllowed = !input.threePhaseLoad || ups.maxParallel > 1;
      if (ups.inputPhases === 1 && ups.outputPhases === 1 &&
          ups.allowPerPhase && p.allowSinglePhaseUpsPerPhase &&
          parallelAllowed) {
        result.push("perphase");
      }
      return result;
    }

    function composition(ups, count) {
      let current = ups;
      let total = count;
      const visited = new Set();
      while (current.kitOf && !visited.has(current.sku)) {
        visited.add(current.sku);
        const base = catalog.ups.find(item => item.sku === current.kitOf.sku);
        if (!base) break;
        total *= current.kitOf.count;
        current = base;
      }
      return `${current.sku}|${total}`;
    }

    function build(ups, battery, scheme, initialN) {
      const groups = scheme === "perphase" ? 3 : 1;
      const phaseFactor = scheme === "perphase"
        ? p.phaseUnbalanceFactor / 3 : 1;
      const Pg = P * phaseFactor;
      const Sg = S * phaseFactor;
      const peakG = peak * phaseFactor;
      const eta = (ups.efficiencyPct ?? p.defaultEfficiencyPct) / 100;
      const dodU = (ups.dodPct ?? p.defaultDodPct) / 100;
      const dodB = battery
        ? (battery.dodPct ?? p.defaultDodPct) / 100
        : p.defaultDodPct / 100;
      const requiredUsefulWh = Pg * input.minutes / 60 / eta * aging;
      let N = initialN;
      const warnings = [];
      const failures = [];

      if (ups.efficiencyPct == null) {
        warnings.push("КПД не указан в паспорте, использовано значение по умолчанию.");
      }
      if (scheme === "perphase" && input.threePhaseLoad) {
        warnings.push("Для трёхфазных потребителей требуется синхронная работа ИБП по фазам. Подтвердите возможность у производителя.");
      }
      if (scheme === "three") {
        warnings.push("Вводной ток рассчитан при равномерном распределении нагрузки по входным фазам.");
      }

      if (ups.batteryType === "builtin" && p.growUpsCountForBuiltInEnergy) {
        const energyN = Math.ceil((requiredUsefulWh - EPS) /
          (ups.builtInEnergyKwh * 1000 * dodU));
        N = Math.min(ups.maxParallel, Math.max(N, energyN));
      }

      const builtWh = N * ups.builtInEnergyKwh * 1000;
      const builtUsefulWh = builtWh * dodU;
      const Kmax = N * ups.maxExternalBatteriesPerUps;
      let K = 0;
      let energyK = 0;
      let currentK = 0;
      let recommendedK = 0;

      if (battery) {
        energyK = Math.max(
          ups.batteryType === "external" ? 1 : 0,
          Math.ceil((requiredUsefulWh - builtUsefulWh - EPS) /
            (battery.energyKwh * 1000 * dodB))
        );

        if (ups.batteryType === "external") {
          const dischargeA = Pg / eta / battery.voltageV;
          if (positive(battery.maxDischargeA)) {
            currentK = Math.ceil((dischargeA - EPS) / battery.maxDischargeA);
          } else {
            warnings.push("Допустимый ток разряда АКБ не проверен. Подтвердите его у производителя.");
          }
        }

        const applyRecommended =
          positive(ups.recommendedAhPerUpsInParallel) &&
          (N >= 2 || p.recommendedCapacityForSingleUps);

        if (applyRecommended && p.recommendedCapacityMandatory) {
          if (positive(battery.capacityAh)) {
            recommendedK = Math.ceil(
              ups.recommendedAhPerUpsInParallel * N / battery.capacityAh
            );
          } else {
            failures.push("Не удалось проверить обязательную рекомендуемую ёмкость");
          }
        }

        K = Math.min(
          Math.max(energyK, currentK, recommendedK),
          Kmax
        );

        if (energyK > Kmax) {
          failures.push("Не хватает энергии АКБ даже при максимальном количестве АКБ");
        }
        if (currentK > Kmax) {
          failures.push("Ток разряда больше допустимого");
        }
        if (recommendedK > Kmax) {
          failures.push("Обязательная рекомендуемая ёмкость превышает предел АКБ");
        }
        if (applyRecommended && positive(battery.capacityAh) &&
            K * battery.capacityAh + EPS <
              ups.recommendedAhPerUpsInParallel * N) {
          warnings.push("Рекомендуемая производителем ёмкость банка АКБ не достигнута.");
        }
      }

      const usedBattery = K > 0 ? battery : null;
      const externalWh = usedBattery
        ? K * usedBattery.energyKwh * 1000 : 0;
      const fullWh = builtWh + externalWh;
      const usefulWh = builtUsefulWh + externalWh * dodB;
      const runtimeMin = usefulWh * eta / Pg * 60 / aging;
      const deltaMin = runtimeMin - input.minutes;
      const deltaPct = deltaMin / input.minutes * 100;

      if (deltaMin < -EPS &&
          !failures.some(reason => reason.includes("энергии АКБ"))) {
        failures.push(
          ups.batteryType === "builtin"
            ? "Встроенной АКБ недостаточно, расширение не предусмотрено"
            : battery
              ? "Не хватает энергии АКБ даже при максимальном количестве АКБ"
              : "Нет совместимой АКБ для необходимого расширения"
        );
      }

      if (ups.batteryType === "builtin+external" && usedBattery) {
        warnings.push("Распределение тока между встроенной и внешней АКБ не проверено.");
      }

      if (positive(ups.overloadPct)) {
        if (peakG / 1000 >
            N * ups.ratedKva * ups.overloadPct / 100 + EPS) {
          warnings.push("Возможен отказ при пуске индуктивной нагрузки. Пиковая мощность превышает перегрузочную способность ИБП.");
        }
        if (input.inductiveW > 0) {
          warnings.push("Длительность пуска не проверена. Подтвердите возможность запуска нагрузки у производителя.");
        }
      } else if (input.inductiveW > 0) {
        warnings.push("Пусковой ток не проверен из-за отсутствия паспортных данных.");
      }

      const U = positive(ups.batteryVoltageV)
        ? ups.batteryVoltageV : usedBattery?.voltageV;
      if (!positive(U)) {
        reject("Не указано напряжение АКБ, расчёт невозможен", ups.sku);
        return;
      }

      const chargeA = Math.min(
        ups.maxChargeCurrentA ?? p.defaultChargeCurrentA,
        CHARGE_LIMIT_A
      );
      if (ups.maxChargeCurrentA == null) {
        warnings.push("Паспортный ток заряда отсутствует. Использовано значение по умолчанию с ограничением тока.");
      }

      let bankAh = builtWh / U;
      if (usedBattery) {
        bankAh += K * (
          usedBattery.capacityAh ?? usedBattery.energyKwh * 1000 / U
        );
      }
      const fastBankA = N * chargeA;
      const slowBankA = Math.min(fastBankA, 0.3 * bankAh);
      const chargeMinH = usefulWh / (U * fastBankA) * p.chargeTailFactor;
      const chargeMaxH = usefulWh / (U * slowBankA) * p.chargeTailFactor;

      if (fastBankA > 0.3 * bankAh + EPS) {
        warnings.push("Быстрая граница времени заряда требует подтверждения допустимого зарядного тока АКБ и BMS.");
      }
      warnings.push("Время заряда ориентировочное. Температура и алгоритм BMS не учтены.");

      if (p.maxChargeTimeH != null &&
          chargeMaxH > p.maxChargeTimeH + EPS) {
        reject("Время заряда больше допустимого", ups.sku);
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

      const breakerA = p.breakerSeriesA.find(value =>
        value + EPS >= inputA * p.breakerReserveFactor
      ) ?? null;

      const allocatedKw = breakerA == null ? null :
        (input.network === 3
          ? Math.sqrt(3) * input.voltage
          : input.voltage) * breakerA / 1000;

      let product = ups;
      let productCount = N * groups;
      let replacement = false;
      const outputPhases = scheme === "perphase" ? 3 : ups.outputPhases;

      if (p.replaceGroupWithKit && !usedBattery && productCount > 1) {
        const kit = catalog.ups.find(item =>
          item.kitOf?.sku === ups.sku &&
          item.kitOf.count === productCount &&
          item.outputPhases === outputPhases &&
          item.inputPhases === input.network &&
          item.batteryType === "builtin"
        );
        if (kit) {
          product = kit;
          productCount = 1;
          replacement = true;
        }
      }

      const upsCost = product.showPrice
        ? product.priceRub * productCount : null;
      const batteryCost = usedBattery
        ? usedBattery.showPrice
          ? usedBattery.priceRub * K * groups
          : null
        : 0;
      const totalCost = upsCost == null || batteryCost == null
        ? null : upsCost + batteryCost;

      const dates = [product.priceDate ?? catalog.meta.defaultPriceDate];
      if (usedBattery) {
        dates.push(usedBattery.priceDate ?? catalog.meta.defaultPriceDate);
      }

      const sharedBank =
        scheme === "perphase" &&
        ups.maxParallel > 1 &&
        !!usedBattery;
      if (sharedBank) {
        warnings.push("Предполагается общий внешний банк АКБ на три фазы. Подтвердите допустимость схемы у производителя.");
      }

      const status = failures.length || deltaMin < -EPS
        ? "не соответствует"
        : deltaPct <= p.statusReserveThresholdPct + EPS
          ? "соответствует" : "запас";

      failures.forEach(reason => reject(reason, ups.sku));

      const key = [
        composition(ups, N * groups),
        outputPhases,
        usedBattery?.sku ?? "",
        K * groups,
        scheme === "perphase" && usedBattery && !sharedBank
          ? "separate" : "common"
      ].join("|");

      candidates.push({
        key,
        order: ups.order,
        product,
        productCount,
        replacement,
        ups,
        battery: usedBattery,
        scheme,
        groups,
        N,
        K,
        totalUps: N * groups,
        totalBatteries: K * groups,
        sharedBank,
        ratedKw: N * groups * ups.ratedKw,
        ratedKva: N * groups * ups.ratedKva,
        loadKwPct: Pg / (N * ups.ratedKw * 1000) * 100,
        loadKvaPct: Sg / (N * ups.ratedKva * 1000) * 100,
        builtEnergyKwh: builtWh * groups / 1000,
        fullEnergyKwh: fullWh * groups / 1000,
        usefulEnergyKwh: usefulWh * groups / 1000,
        runtimeMin,
        deltaMin,
        deltaPct,
        chargeA,
        chargeMinH,
        chargeMaxH,
        breakerA,
        allocatedKw,
        upsCost,
        batteryCost,
        totalCost,
        priceDate: dates.sort()[0],
        status,
        failures,
        warnings: [...new Set(warnings)]
      });
    }

    catalog.ups.forEach(ups => {
      const allowed = schemes(ups);
      if (!allowed.length) {
        reject("Нет допустимой схемы подключения для выбранной сети и потребителей", ups.sku);
        return;
      }

      allowed.forEach(scheme => {
        const phaseFactor = scheme === "perphase"
          ? p.phaseUnbalanceFactor / 3 : 1;
        const N = Math.max(1, Math.ceil(Math.max(
          P * phaseFactor * reserve / (ups.ratedKw * 1000),
          S * phaseFactor * reserve / (ups.ratedKva * 1000)
        ) - EPS));

        if (N > ups.maxParallel) {
          reject("Не хватает мощности ИБП даже при максимальном числе ИБП в параллели", ups.sku);
          return;
        }

        if (ups.batteryType === "builtin") {
          build(ups, null, scheme, N);
          return;
        }

        const matching = catalog.batteries.filter(battery =>
          compatible(ups, battery));

        if (ups.batteryType === "builtin+external") {
          const eta = (ups.efficiencyPct ?? p.defaultEfficiencyPct) / 100;
          const dod = (ups.dodPct ?? p.defaultDodPct) / 100;
          const available = N * ups.builtInEnergyKwh * 1000 * dod;
          const required = P * phaseFactor * input.minutes / 60 / eta * aging;

          if (available + EPS >= required || !matching.length) {
            build(ups, null, scheme, N);
          }
        }

        if (!matching.length) reject("Нет совместимой АКБ", ups.sku);
        matching.forEach(battery => build(ups, battery, scheme, N));
      });
    });

    const unique = new Map();
    candidates.forEach(candidate => {
      const old = unique.get(candidate.key);
      if (!old || (candidate.replacement && !old.replacement)) {
        unique.set(candidate.key, candidate);
      }
    });

    const all = [...unique.values()];
    const successful = all.filter(candidate =>
      candidate.status !== "не соответствует");

    const compareCost = (a, b) => {
      const x = a.totalCost ?? Infinity;
      const y = b.totalCost ?? Infinity;
      return x === y ? 0 : x < y ? -1 : 1;
    };
    const compareRuntime = (a, b) =>
      b.runtimeMin - a.runtimeMin ||
      compareCost(a, b) ||
      a.order - b.order;

    const selected = [];
    const add = (candidate, label) => {
      if (!candidate) return;
      let existing = selected.find(item => item.key === candidate.key);
      if (!existing) {
        existing = { ...candidate, labels: [] };
        selected.push(existing);
      }
      existing.labels.push(label);
    };

    let priceLimitRub = null;
    let aCostRub = null;
    let mode = "fallback";

    if (successful.length) {
      const priced = successful.filter(candidate =>
        candidate.totalCost != null);
      const A = [...priced].sort((a, b) =>
        compareCost(a, b) || compareRuntime(a, b)
      )[0];

      if (A) {
        aCostRub = A.totalCost;
        priceLimitRub = A.totalCost * 1.7;
        add(A, "А – минимальная стоимость");
        mode = "priced";
      } else {
        mode = "unpriced";
      }

      const bPool = successful.filter(candidate =>
        candidate.totalCost == null ||
        priceLimitRub == null ||
        candidate.totalCost <= priceLimitRub + EPS
      );
      const B = [...bPool].sort(compareRuntime)[0];
      add(B, "Б – максимальная автономия");

      selected.forEach(candidate => {
        if (candidate.totalCost == null) {
          candidate.warnings = [
            ...candidate.warnings,
            "Цена по запросу. Ограничение стоимости относительно варианта А не проверено."
          ];
        }
      });
    } else {
      [...all].sort(compareRuntime).slice(0, 2).forEach(candidate => {
        add(candidate, "Ближайшая конфигурация – цель или ограничения не выполнены");
      });
    }

    function range(values) {
      const known = values.filter(finite);
      return known.length
        ? [Math.min(...known), Math.max(...known)] : null;
    }

    requirements.allocatedKwRange = range(
      selected.map(candidate => candidate.allocatedKw)
    );
    requirements.breakerRange = range(
      selected.map(candidate => candidate.breakerA)
    );
    requirements.breakerAboveRange = selected.some(candidate =>
      candidate.breakerA == null
    );
    requirements.chargeRangeH = selected.length ? [
      Math.min(...selected.map(candidate => candidate.chargeMinH)),
      Math.max(...selected.map(candidate => candidate.chargeMaxH))
    ] : null;

    return {
      inputErrors: {},
      input,
      requirements,
      selected,
      successfulCount: successful.length,
      candidateCount: all.length,
      aCostRub,
      priceLimitRub,
      mode,
      maxBreakerA: Math.max(...p.breakerSeriesA),
      rejections: [...rejected].map(([reason, records]) => ({
        reason,
        count: records.size
      }))
    };
  }

  return {
    parseCatalog,
    validateCatalog,
    validateInput,
    calculate,
    duration
  };
})();
