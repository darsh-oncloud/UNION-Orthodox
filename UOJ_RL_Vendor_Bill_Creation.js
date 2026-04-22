/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/format', 'N/log', 'N/runtime'], function (record, format, log, runtime) {

  function isEmpty(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  function isObject(o) {
    return o && typeof o === 'object' && !Array.isArray(o);
  }

  function parseNsDate(v) {
    if (isEmpty(v)) return null;
    return format.parse({ value: String(v), type: format.Type.DATE });
  }

  function respSuccess(data) {
    return {
      Status: 'success',
      Code: 200,
      Message: 'Record processed successfully',
      Data: data
    };
  }

  function respFail(code, msg) {
    return {
      Status: 'failed',
      Code: code,
      Message: msg
    };
  }

  function getVendorCreditFormParam() {
    return runtime.getCurrentScript().getParameter({
      name: 'custscript_vendor_credit_form'
    });
  }

  function setBodyFields(recObj, payload, skipCustomForm) {
    for (var k in payload) {
      if (!payload.hasOwnProperty(k)) continue;
      if (k === 'expense' || k === 'item' || k === 'customform1' || k === 'usertotal') continue;
      if (skipCustomForm && k === 'customform') continue;

      var val = payload[k];
      if (isEmpty(val)) continue;

      if (k === 'trandate' || k === 'duedate') {
        var d = parseNsDate(val);
        if (d) {
          recObj.setValue({ fieldId: k, value: d });
        }
      } else {
        recObj.setValue({ fieldId: k, value: val });
      }
    }
  }

  function setLineFields(recObj, sublistId, lineObj) {
    for (var k in lineObj) {
      if (!lineObj.hasOwnProperty(k)) continue;
      if (k === 'transactiontype') continue;

      var val = lineObj[k];
      if (isEmpty(val)) continue;

      recObj.setCurrentSublistValue({
        sublistId: sublistId,
        fieldId: k,
        value: val
      });
    }
  }

  function splitLines(lines) {
    var out = {
      debit: [],
      credit: []
    };

    if (!Array.isArray(lines)) return out;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!isObject(line)) continue;

      var type = String(line.transactiontype || 'Debit').toLowerCase();

      if (type === 'credit') {
        out.credit.push(line);
      } else {
        out.debit.push(line);
      }
    }

    return out;
  }

  function createTransaction(recType, payload, expenseLines) {
    var recObj = record.create({
      type: recType,
      isDynamic: true
    });

    var skipCustomForm = false;

    if (recType === record.Type.VENDOR_CREDIT) {
      var vendorCreditForm = getVendorCreditFormParam();
      if (!isEmpty(vendorCreditForm)) {
        recObj.setValue({
          fieldId: 'customform',
          value: vendorCreditForm
        });
      }
      skipCustomForm = true;
    }

    setBodyFields(recObj, payload, skipCustomForm);

    if (expenseLines.length > 0) {
      for (var i = 0; i < expenseLines.length; i++) {
        recObj.selectNewLine({ sublistId: 'expense' });
        setLineFields(recObj, 'expense', expenseLines[i]);
        recObj.commitLine({ sublistId: 'expense' });
      }
    }

    return recObj.save({
      enableSourcing: true,
      ignoreMandatoryFields: false
    });
  }

  function applyVendorCredit(creditId, billId) {
    var appliedBills = [];

    if (isEmpty(billId)) {
      return appliedBills;
    }

    var vc = record.load({
      type: record.Type.VENDOR_CREDIT,
      id: creditId,
      isDynamic: true
    });

    var lineCount = vc.getLineCount({ sublistId: 'apply' });

    for (var i = 0; i < lineCount; i++) {
      var applyBillId = vc.getSublistValue({
        sublistId: 'apply',
        fieldId: 'internalid',
        line: i
      });

      if (String(applyBillId) === String(billId)) {
        vc.selectLine({ sublistId: 'apply', line: i });

        var due = parseFloat(vc.getCurrentSublistValue({
          sublistId: 'apply',
          fieldId: 'due'
        })) || 0;

        var creditTotal = parseFloat(vc.getValue({
          fieldId: 'usertotal'
        })) || 0;

        var applyAmt = due < creditTotal ? due : creditTotal;

        if (applyAmt > 0) {
          vc.setCurrentSublistValue({
            sublistId: 'apply',
            fieldId: 'apply',
            value: true
          });

          vc.setCurrentSublistValue({
            sublistId: 'apply',
            fieldId: 'amount',
            value: applyAmt
          });

          appliedBills.push({
            billId: String(applyBillId),
            amount: applyAmt
          });
        }

        vc.commitLine({ sublistId: 'apply' });
        break;
      }
    }

    vc.save({
      enableSourcing: true,
      ignoreMandatoryFields: false
    });

    return appliedBills;
  }

  function doPost(context) {
    try {
      log.debug('RESTlet POST requestBody', context);

      if (!isObject(context)) {
        return respFail(400, 'POST body must be a JSON object');
      }

      if (isEmpty(context.entity)) {
        return respFail(400, 'Missing required field: entity');
      }

      var expenseSplit = splitLines(context.expense);

      var hasDebit = expenseSplit.debit.length > 0;
      var hasCredit = expenseSplit.credit.length > 0;

      if (!hasDebit && !hasCredit) {
        return respFail(400, 'Payload must include Debit or Credit lines in expense array');
      }

      var result = {
        vendorBillId: null,
        vendorCreditId: null,
        appliedBills: []
      };

      if (hasDebit) {
        result.vendorBillId = createTransaction(
          record.Type.VENDOR_BILL,
          context,
          expenseSplit.debit
        );
      }

      if (hasCredit) {
        result.vendorCreditId = createTransaction(
          record.Type.VENDOR_CREDIT,
          context,
          expenseSplit.credit
        );
      }

      if (result.vendorCreditId && result.vendorBillId) {
        result.appliedBills = applyVendorCredit(result.vendorCreditId, result.vendorBillId);
      }

      log.audit('RESTlet Success', result);
      return respSuccess(result);

    } catch (e) {
      log.error('RESTlet POST Error', e);

      var msg = (e && e.message) ? e.message : String(e);
      var code = 500;
      var name = (e && e.name) ? e.name : '';

      if (name === 'USER_ERROR' || name === 'SSS_MISSING_REQD_ARGUMENT') {
        code = 400;
      }

      return respFail(code, msg);
    }
  }

  function doGet(context) {
    return {
      Status: 'success',
      Code: 200,
      Message: 'success GET',
      Params: context || {}
    };
  }

  return {
    get: doGet,
    post: doPost
  };
});