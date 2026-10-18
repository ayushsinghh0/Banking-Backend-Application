"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyStatus = exports.EntryType = exports.TransactionStatus = exports.TransactionType = void 0;
var TransactionType;
(function (TransactionType) {
    TransactionType["DEPOSIT"] = "DEPOSIT";
    TransactionType["WITHDRAWAL"] = "WITHDRAWAL";
    TransactionType["TRANSFER"] = "TRANSFER";
})(TransactionType || (exports.TransactionType = TransactionType = {}));
var TransactionStatus;
(function (TransactionStatus) {
    TransactionStatus["PENDING"] = "PENDING";
    TransactionStatus["COMPLETED"] = "COMPLETED";
    TransactionStatus["FAILED"] = "FAILED";
    TransactionStatus["REVERSED"] = "REVERSED";
})(TransactionStatus || (exports.TransactionStatus = TransactionStatus = {}));
var EntryType;
(function (EntryType) {
    EntryType["DEBIT"] = "DEBIT";
    EntryType["CREDIT"] = "CREDIT";
})(EntryType || (exports.EntryType = EntryType = {}));
var IdempotencyStatus;
(function (IdempotencyStatus) {
    IdempotencyStatus["PROCESSING"] = "PROCESSING";
    IdempotencyStatus["COMPLETED"] = "COMPLETED";
    IdempotencyStatus["FAILED"] = "FAILED";
})(IdempotencyStatus || (exports.IdempotencyStatus = IdempotencyStatus = {}));
