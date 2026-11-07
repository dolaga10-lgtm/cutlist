/**
 * CutList Optimizer v1.126 — Native Android Bridge & Multi-Strategy 2D Guillotine Solver
 * Emulates the exact `window.android` JavascriptInterface from com.cutlistoptimizer (classes.dex)
 * and runs 100% locally in the browser / WebView with zero external server dependency.
 */
(function () {
    // Non-blocking toast helper for sandboxed environments
    function showInPageNotice(msg, isError) {
        try {
            var container = document.querySelector('.toast-top-right');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                container.className = 'toast-top-right';
                container.style.cssText = 'position:fixed;top:58px;right:12px;z-index:999999;';
                document.body.appendChild(container);
            }
            var toast = document.createElement('div');
            toast.className = 'toast ' + (isError ? 'toast-error' : 'toast-info');
            toast.style.cssText = 'margin-bottom:6px;padding:12px 16px;border-radius:4px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.3);font-size:13px;min-width:240px;background-color:' + (isError ? '#c62828' : '#2e7d32') + ';';
            toast.textContent = msg;
            container.appendChild(toast);
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 3200);
        } catch (e) {
            console.log("Notice:", msg);
        }
    }

    // Override window.alert and window.confirm so they never fail inside sandboxed iframes
    var origConfirm = window.confirm;
    window.alert = function (msg) {
        showInPageNotice(String(msg || ''), false);
    };
    window.confirm = function (msg) {
        try {
            var r = origConfirm.call(window, msg);
            if (typeof r === 'boolean') return r;
        } catch (e) {}
        return true;
    };

    var tasksStore = {};

    function solveCutList(request) {
        var cfg = request.configuration || {};
        var kerf = Math.max(0, parseFloat(cfg.cutThickness) || 0);
        var minTrim = Math.max(0, parseFloat(cfg.minTrimDimension) || 0);
        var considerMaterial = !!cfg.isMaterialEnabled;
        var considerGrain = !!cfg.considerOrientation;
        var hasEdgeBanding = !!cfg.hasEdgeBanding;
        var useSingleStock = !!cfg.useSingleStockUnit;
        var priority = parseInt(cfg.optimizationPriority) || 0;
        var cutPref = parseInt(cfg.cutOrientationPreference) || 0;

        var reqPanels = [];
        var panelSummaryMap = {};
        (request.panels || []).forEach(function (p) {
            if (!p.enabled) return;
            var w = parseFloat(p.width);
            var h = parseFloat(p.height);
            var count = parseInt(p.count) || 0;
            if (!(w > 0 && h > 0 && count > 0)) return;
            var mat = considerMaterial ? (p.material || '') : '';
            var ori = considerGrain ? (parseInt(p.orientation) || 0) : 0;
            var edge = hasEdgeBanding && p.edge ? {
                top: p.edge.top || null,
                bottom: p.edge.bottom || null,
                left: p.edge.left || null,
                right: p.edge.right || null
            } : { top: null, bottom: null, left: null, right: null };

            panelSummaryMap[p.id] = {
                requestObjId: p.id,
                width: w,
                height: h,
                count: count,
                label: p.label || null,
                material: p.material || null,
                enabled: true
            };

            for (var i = 0; i < count; i++) {
                reqPanels.push({
                    requestObjId: p.id,
                    width: w,
                    height: h,
                    label: p.label || null,
                    material: mat,
                    rawMaterial: p.material || null,
                    orientation: ori,
                    edge: edge
                });
            }
        });

        var availStocks = [];
        (request.stockPanels || []).forEach(function (s) {
            if (!s.enabled) return;
            var w = parseFloat(s.width);
            var h = parseFloat(s.height);
            var count = parseInt(s.count) || 0;
            if (!(w > 0 && h > 0 && count > 0)) return;
            var mat = considerMaterial ? (s.material || '') : '';
            var ori = considerGrain ? (parseInt(s.orientation) || 0) : 0;
            var maxCount = useSingleStock ? 1 : count;
            for (var i = 0; i < maxCount; i++) {
                availStocks.push({
                    requestObjId: s.id,
                    width: w,
                    height: h,
                    label: s.label || null,
                    material: mat,
                    rawMaterial: s.material || null,
                    orientation: ori
                });
                if (useSingleStock && availStocks.length >= 1) break;
            }
        });

        if (priority === 2) {
            availStocks.sort(function (a, b) { return (a.width * a.height) - (b.width * b.height); });
        } else {
            availStocks.sort(function (a, b) { return (b.width * b.height) - (a.width * a.height); });
        }

        function canFit(part, rectW, rectH, stockOri) {
            var eps = 1e-6;
            var normalOk = (part.width <= rectW + eps && part.height <= rectH + eps);
            var rotOk = (part.height <= rectW + eps && part.width <= rectH + eps);

            if (considerGrain && part.orientation !== 0 && stockOri !== 0) {
                if (part.orientation === stockOri) {
                    rotOk = false;
                } else {
                    normalOk = false;
                }
            } else if (considerGrain && part.orientation !== 0 && stockOri === 0) {
                if (part.orientation === 2) rotOk = false;
                if (part.orientation === 1) normalOk = false;
            }
            return { normalOk: normalOk, rotOk: rotOk };
        }

        function packSingleSheet(stock, pool, strategy) {
            var localPool = pool.slice();
            var nextTileId = 1;
            var tiles = [];
            var cuts = [];

            var rootTile = {
                id: nextTileId++,
                requestObjId: stock.requestObjId,
                x: 0,
                y: 0,
                width: stock.width,
                height: stock.height,
                hasChildren: false,
                final: false,
                rotated: false,
                label: stock.label,
                orientation: stock.orientation,
                edge: null
            };
            tiles.push(rootTile);

            function packNode(node) {
                var bestIdx = -1;
                var bestRotated = false;
                var bestScore = Infinity;

                for (var i = 0; i < localPool.length; i++) {
                    var p = localPool[i];
                    if (considerMaterial && p.material !== stock.material) continue;
                    var fit = canFit(p, node.width, node.height, stock.orientation);
                    if (!fit.normalOk && !fit.rotOk) continue;

                    var candidates = [];
                    if (fit.normalOk) candidates.push({ rot: false, pw: p.width, ph: p.height });
                    if (fit.rotOk && (p.width !== p.height || !fit.normalOk)) candidates.push({ rot: true, pw: p.height, ph: p.width });

                    var sameCount = 0;
                    for (var m = 0; m < localPool.length; m++) {
                        if (Math.abs(localPool[m].width - p.width) < 1e-4 && Math.abs(localPool[m].height - p.height) < 1e-4) sameCount++;
                    }

                    for (var cIdx = 0; cIdx < candidates.length; cIdx++) {
                        var c = candidates[cIdx];
                        var exactW = Math.abs(node.width - c.pw) < 1e-5;
                        var exactH = Math.abs(node.height - c.ph) < 1e-5;
                        var remW = node.width - c.pw;
                        var remH = node.height - c.ph;

                        var colsW = Math.min(sameCount, Math.floor((node.width + kerf) / (c.pw + kerf)));
                        var rowsH = Math.min(sameCount, Math.floor((node.height + kerf) / (c.ph + kerf)));
                        var wUtil = (colsW * c.pw) / node.width;
                        var hUtil = (rowsH * c.ph) / node.height;

                        var siblingFitsRight = false;
                        var siblingFitsTop = false;
                        var leftW = node.width - c.pw - kerf;
                        var leftH = node.height - c.ph - kerf;
                        for (var k = 0; k < localPool.length; k++) {
                            if (k === i) continue;
                            var sp = localPool[k];
                            if (considerMaterial && sp.material !== stock.material) continue;
                            if (leftW > 0) {
                                var fR = canFit(sp, leftW, node.height, stock.orientation);
                                if (fR.normalOk || fR.rotOk) siblingFitsRight = true;
                            }
                            if (leftH > 0) {
                                var fT = canFit(sp, node.width, leftH, stock.orientation);
                                if (fT.normalOk || fT.rotOk) siblingFitsTop = true;
                            }
                            if (siblingFitsRight && siblingFitsTop) break;
                        }
                        var pairBonus = (siblingFitsRight ? 50000000 : 0) + (siblingFitsTop ? 50000000 : 0);

                        var sMode = strategy % 4;
                        var score = 0;
                        if (sMode === 0) {
                            score = (exactW && exactH) ? -1e12 : (exactW || exactH) ? -1e10 - (c.pw * c.ph) : -(pairBonus + Math.max(wUtil, hUtil) * 5000000 + (c.pw * c.ph) * 10);
                        } else if (sMode === 1) {
                            score = (exactW && exactH) ? -1e12 : (exactW || exactH) ? -1e10 - (c.pw * c.ph) : -(pairBonus + wUtil * 10000000 + (c.pw * c.ph) * 10);
                        } else if (sMode === 2) {
                            score = (exactW && exactH) ? -1e12 : (exactW || exactH) ? -1e10 - (c.pw * c.ph) : -(pairBonus + hUtil * 10000000 + (c.pw * c.ph) * 10);
                        } else {
                            score = (exactW && exactH) ? -1e12 : (exactW || exactH) ? -1e10 - (c.pw * c.ph) : Math.min(remW, remH) * 500 - (c.pw * c.ph);
                        }

                        if (score < bestScore) {
                            bestScore = score;
                            bestIdx = i;
                            bestRotated = c.rot;
                        }
                    }
                }

                if (bestIdx === -1) return;

                var chosen = localPool.splice(bestIdx, 1)[0];
                var pw = bestRotated ? chosen.height : chosen.width;
                var ph = bestRotated ? chosen.width : chosen.height;
                var dw = node.width - pw;
                var dh = node.height - ph;
                var eps = 1e-4;

                if (dw <= eps && dh <= eps) {
                    node.final = true;
                    node.isFinal = true;
                    node.requestObjId = chosen.requestObjId;
                    node.label = chosen.label;
                    node.rotated = bestRotated;
                    node.isRotated = bestRotated;
                    node.edge = chosen.edge;
                    return;
                }

                var remSame = 1;
                for (var idx2 = 0; idx2 < localPool.length; idx2++) {
                    if (Math.abs(localPool[idx2].width - chosen.width) < 1e-4 && Math.abs(localPool[idx2].height - chosen.height) < 1e-4) remSame++;
                }
                var colsChosen = Math.min(remSame, Math.floor((node.width + kerf) / (pw + kerf)));
                var rowsChosen = Math.min(remSame, Math.floor((node.height + kerf) / (ph + kerf)));
                var wUtilChosen = (colsChosen * pw) / node.width;
                var hUtilChosen = (rowsChosen * ph) / node.height;

                var splitAlongXFirst = true;
                if (cutPref === 1) {
                    splitAlongXFirst = false;
                } else if (cutPref === 2) {
                    splitAlongXFirst = true;
                } else if (colsChosen >= 2 && wUtilChosen >= hUtilChosen) {
                    splitAlongXFirst = false;
                } else if (rowsChosen >= 2 && hUtilChosen > wUtilChosen) {
                    splitAlongXFirst = true;
                } else if (strategy % 2 === 0) {
                    splitAlongXFirst = (dw < dh);
                } else {
                    splitAlongXFirst = (dw >= dh);
                }

                if (splitAlongXFirst) {
                    if (dw > eps) {
                        node.hasChildren = true;
                        var leftW = pw;
                        var rightW = Math.max(0, node.width - pw - kerf);
                        var child1 = {
                            id: nextTileId++, requestObjId: null,
                            x: node.x, y: node.y, width: leftW, height: node.height,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        };
                        var child2 = rightW > minTrim ? {
                            id: nextTileId++, requestObjId: null,
                            x: node.x + pw + kerf, y: node.y, width: rightW, height: node.height,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        } : null;
                        tiles.push(child1);
                        if (child2) tiles.push(child2);

                        cuts.push({
                            originalTileId: node.id, originalWidth: node.width, originalHeight: node.height,
                            x1: node.x + pw, y1: node.y, x2: node.x + pw, y2: node.y + node.height,
                            cutCoord: pw, horizontal: true, isHorizontal: true,
                            child1TileId: child1.id, child2TileId: child2 ? child2.id : -1
                        });

                        if (dh > eps) {
                            child1.hasChildren = true;
                            var botH = ph;
                            var topH = Math.max(0, child1.height - ph - kerf);
                            var gc1 = {
                                id: nextTileId++, requestObjId: chosen.requestObjId,
                                x: child1.x, y: child1.y, width: pw, height: botH,
                                hasChildren: false, final: true, isFinal: true, rotated: bestRotated, isRotated: bestRotated,
                                label: chosen.label, orientation: chosen.orientation, edge: chosen.edge
                            };
                            var gc2 = topH > minTrim ? {
                                id: nextTileId++, requestObjId: null,
                                x: child1.x, y: child1.y + ph + kerf, width: pw, height: topH,
                                hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                            } : null;
                            tiles.push(gc1);
                            if (gc2) tiles.push(gc2);
                            cuts.push({
                                originalTileId: child1.id, originalWidth: child1.width, originalHeight: child1.height,
                                x1: child1.x, y1: child1.y + ph, x2: child1.x + child1.width, y2: child1.y + ph,
                                cutCoord: ph, horizontal: false, isHorizontal: false,
                                child1TileId: gc1.id, child2TileId: gc2 ? gc2.id : -1
                            });
                            if (gc2) packNode(gc2);
                        } else {
                            child1.final = true; child1.isFinal = true;
                            child1.requestObjId = chosen.requestObjId; child1.label = chosen.label;
                            child1.rotated = bestRotated; child1.isRotated = bestRotated; child1.edge = chosen.edge;
                        }
                        if (child2) packNode(child2);
                    } else {
                        node.hasChildren = true;
                        var botH2 = ph;
                        var topH2 = Math.max(0, node.height - ph - kerf);
                        var c1 = {
                            id: nextTileId++, requestObjId: chosen.requestObjId,
                            x: node.x, y: node.y, width: pw, height: botH2,
                            hasChildren: false, final: true, isFinal: true, rotated: bestRotated, isRotated: bestRotated,
                            label: chosen.label, orientation: chosen.orientation, edge: chosen.edge
                        };
                        var c2 = topH2 > minTrim ? {
                            id: nextTileId++, requestObjId: null,
                            x: node.x, y: node.y + ph + kerf, width: pw, height: topH2,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        } : null;
                        tiles.push(c1);
                        if (c2) tiles.push(c2);
                        cuts.push({
                            originalTileId: node.id, originalWidth: node.width, originalHeight: node.height,
                            x1: node.x, y1: node.y + ph, x2: node.x + node.width, y2: node.y + ph,
                            cutCoord: ph, horizontal: false, isHorizontal: false,
                            child1TileId: c1.id, child2TileId: c2 ? c2.id : -1
                        });
                        if (c2) packNode(c2);
                    }
                } else {
                    if (dh > eps) {
                        node.hasChildren = true;
                        var botH3 = ph;
                        var topH3 = Math.max(0, node.height - ph - kerf);
                        var ch1 = {
                            id: nextTileId++, requestObjId: null,
                            x: node.x, y: node.y, width: node.width, height: botH3,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        };
                        var ch2 = topH3 > minTrim ? {
                            id: nextTileId++, requestObjId: null,
                            x: node.x, y: node.y + ph + kerf, width: node.width, height: topH3,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        } : null;
                        tiles.push(ch1);
                        if (ch2) tiles.push(ch2);
                        cuts.push({
                            originalTileId: node.id, originalWidth: node.width, originalHeight: node.height,
                            x1: node.x, y1: node.y + ph, x2: node.x + node.width, y2: node.y + ph,
                            cutCoord: ph, horizontal: false, isHorizontal: false,
                            child1TileId: ch1.id, child2TileId: ch2 ? ch2.id : -1
                        });

                        if (dw > eps) {
                            ch1.hasChildren = true;
                            var leftW2 = pw;
                            var rightW2 = Math.max(0, ch1.width - pw - kerf);
                            var gch1 = {
                                id: nextTileId++, requestObjId: chosen.requestObjId,
                                x: ch1.x, y: ch1.y, width: leftW2, height: ph,
                                hasChildren: false, final: true, isFinal: true, rotated: bestRotated, isRotated: bestRotated,
                                label: chosen.label, orientation: chosen.orientation, edge: chosen.edge
                            };
                            var gch2 = rightW2 > minTrim ? {
                                id: nextTileId++, requestObjId: null,
                                x: ch1.x + pw + kerf, y: ch1.y, width: rightW2, height: ph,
                                hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                            } : null;
                            tiles.push(gch1);
                            if (gch2) tiles.push(gch2);
                            cuts.push({
                                originalTileId: ch1.id, originalWidth: ch1.width, originalHeight: ch1.height,
                                x1: ch1.x + pw, y1: ch1.y, x2: ch1.x + pw, y2: ch1.y + ch1.height,
                                cutCoord: pw, horizontal: true, isHorizontal: true,
                                child1TileId: gch1.id, child2TileId: gch2 ? gch2.id : -1
                            });
                            if (gch2) packNode(gch2);
                        } else {
                            ch1.final = true; ch1.isFinal = true;
                            ch1.requestObjId = chosen.requestObjId; ch1.label = chosen.label;
                            ch1.rotated = bestRotated; ch1.isRotated = bestRotated; ch1.edge = chosen.edge;
                        }
                        if (ch2) packNode(ch2);
                    } else {
                        node.hasChildren = true;
                        var leftW3 = pw;
                        var rightW3 = Math.max(0, node.width - pw - kerf);
                        var chA = {
                            id: nextTileId++, requestObjId: chosen.requestObjId,
                            x: node.x, y: node.y, width: leftW3, height: ph,
                            hasChildren: false, final: true, isFinal: true, rotated: bestRotated, isRotated: bestRotated,
                            label: chosen.label, orientation: chosen.orientation, edge: chosen.edge
                        };
                        var chB = rightW3 > minTrim ? {
                            id: nextTileId++, requestObjId: null,
                            x: node.x + pw + kerf, y: node.y, width: rightW3, height: ph,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        } : null;
                        tiles.push(chA);
                        if (chB) tiles.push(chB);
                        cuts.push({
                            originalTileId: node.id, originalWidth: node.width, originalHeight: node.height,
                            x1: node.x + pw, y1: node.y, x2: node.x + pw, y2: node.y + node.height,
                            cutCoord: pw, horizontal: true, isHorizontal: true,
                            child1TileId: chA.id, child2TileId: chB ? chB.id : -1
                        });
                        if (chB) packNode(chB);
                    }
                }
            }

            packNode(rootTile);

            var usedArea = 0;
            tiles.forEach(function (t) {
                if (!t.hasChildren && t.final) usedArea += t.width * t.height;
            });

            return { tiles: tiles, cuts: cuts, usedArea: usedArea, remaining: localPool };
        }

        var mosaics = [];
        var remainingPanels = reqPanels.slice();

        for (var sIdx = 0; sIdx < availStocks.length; sIdx++) {
            if (remainingPanels.length === 0) break;
            var stock = availStocks[sIdx];

            var matchingIdx = remainingPanels.findIndex(function (p) {
                if (considerMaterial && p.material !== stock.material) return false;
                var fit = canFit(p, stock.width, stock.height, stock.orientation);
                return fit.normalOk || fit.rotOk;
            });
            if (matchingIdx === -1) continue;

            var bestAttempt = null;
            for (var strat = 0; strat < 8; strat++) {
                var attempt = packSingleSheet(stock, remainingPanels, strat);
                if (!bestAttempt) {
                    bestAttempt = attempt;
                } else {
                    if (attempt.usedArea > bestAttempt.usedArea + 1e-3 ||
                       (Math.abs(attempt.usedArea - bestAttempt.usedArea) <= 1e-3 && attempt.cuts.length < bestAttempt.cuts.length)) {
                        bestAttempt = attempt;
                    }
                }
            }

            remainingPanels = bestAttempt.remaining;
            var tiles = bestAttempt.tiles;
            var cuts = bestAttempt.cuts;
            var usedArea = bestAttempt.usedArea;
            var stockArea = stock.width * stock.height;

            var nbrFinal = 0;
            var nbrWasted = 0;
            var mosaicPanelsMap = {};
            var mosaicEdgeBands = {};

            tiles.forEach(function (t) {
                if (!t.hasChildren) {
                    if (t.final) {
                        nbrFinal++;
                        if (!mosaicPanelsMap[t.requestObjId]) {
                            mosaicPanelsMap[t.requestObjId] = {
                                requestObjId: t.requestObjId,
                                width: t.rotated ? t.height : t.width,
                                height: t.rotated ? t.width : t.height,
                                label: t.label,
                                count: 0
                            };
                        }
                        mosaicPanelsMap[t.requestObjId].count++;

                        if (hasEdgeBanding && t.edge) {
                            var origW = t.rotated ? t.height : t.width;
                            var origH = t.rotated ? t.width : t.height;
                            if (t.edge.top) mosaicEdgeBands[t.edge.top] = (mosaicEdgeBands[t.edge.top] || 0) + origW;
                            if (t.edge.bottom) mosaicEdgeBands[t.edge.bottom] = (mosaicEdgeBands[t.edge.bottom] || 0) + origW;
                            if (t.edge.left) mosaicEdgeBands[t.edge.left] = (mosaicEdgeBands[t.edge.left] || 0) + origH;
                            if (t.edge.right) mosaicEdgeBands[t.edge.right] = (mosaicEdgeBands[t.edge.right] || 0) + origH;
                        }
                    } else {
                        nbrWasted++;
                    }
                }
            });

            var cutLength = 0;
            cuts.forEach(function (c) {
                cutLength += Math.hypot(c.x2 - c.x1, c.y2 - c.y1);
            });

            mosaics.push({
                requestStockId: stock.requestObjId,
                stockLabel: stock.label,
                material: stock.rawMaterial,
                usedArea: usedArea,
                wastedArea: Math.max(0, stockArea - usedArea),
                usedAreaRatio: stockArea > 0 ? (usedArea / stockArea) : 0,
                cuts: cuts,
                cutLength: cutLength,
                nbrFinalPanels: nbrFinal,
                nbrWastedPanels: nbrWasted,
                edgeBands: mosaicEdgeBands,
                panels: Object.values(mosaicPanelsMap),
                tiles: tiles
            });
        }

        var totalUsedArea = 0;
        var totalWastedArea = 0;
        var totalNbrCuts = 0;
        var totalCutLength = 0;
        var globalEdgeBands = {};
        var usedStockMap = {};

        mosaics.forEach(function (m) {
            totalUsedArea += m.usedArea;
            totalWastedArea += m.wastedArea;
            totalNbrCuts += m.cuts.length;
            totalCutLength += m.cutLength;
            Object.keys(m.edgeBands || {}).forEach(function (k) {
                globalEdgeBands[k] = (globalEdgeBands[k] || 0) + m.edgeBands[k];
            });
            var sid = m.requestStockId;
            if (!usedStockMap[sid]) {
                usedStockMap[sid] = {
                    requestObjId: sid,
                    width: m.tiles[0].width,
                    height: m.tiles[0].height,
                    label: m.stockLabel,
                    material: m.material,
                    count: 0,
                    enabled: true
                };
            }
            usedStockMap[sid].count++;
        });

        var noFitMap = {};
        remainingPanels.forEach(function (p) {
            if (!noFitMap[p.requestObjId]) {
                noFitMap[p.requestObjId] = {
                    id: p.requestObjId,
                    width: p.width,
                    height: p.height,
                    label: p.label,
                    material: p.rawMaterial,
                    count: 0
                };
            }
            noFitMap[p.requestObjId].count++;
        });

        var totalArea = totalUsedArea + totalWastedArea;
        return {
            id: 'sol-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            taskId: 'task-' + Date.now(),
            version: '1.126',
            elapsedTime: 35,
            solutionElapsedTime: 35,
            totalUsedArea: totalUsedArea,
            totalWastedArea: totalWastedArea,
            totalUsedAreaRatio: totalArea > 0 ? (totalUsedArea / totalArea) : 0,
            totalNbrCuts: totalNbrCuts,
            totalCutLength: totalCutLength,
            edgeBands: globalEdgeBands,
            request: request,
            mosaics: mosaics,
            panels: Object.values(panelSummaryMap),
            usedStockPanels: Object.values(usedStockMap),
            noFitPanels: Object.values(noFitMap)
        };
    }

    // Expose window.android bridge matching com.cutlistoptimizer v1.126
    window.android = {
        compute: function (jsonDataStr) {
            try {
                var req = JSON.parse(jsonDataStr);
                var taskId = 'task-' + Date.now();
                var solution = solveCutList(req);
                solution.taskId = taskId;
                tasksStore[taskId] = {
                    initPercentage: 100,
                    percentageDone: 100,
                    status: 'FINISHED',
                    solution: solution
                };
                return JSON.stringify({ statusCode: 0, taskId: taskId });
            } catch (e) {
                console.error("Native solver error:", e);
                return JSON.stringify({ statusCode: 4, taskId: null });
            }
        },
        getTaskStatus: function (taskId) {
            var t = tasksStore[taskId];
            if (!t) {
                return JSON.stringify({ initPercentage: 100, percentageDone: 100, status: 'FINISHED', solution: null });
            }
            return JSON.stringify(t);
        },
        stopTask: function (taskId) {
            if (tasksStore[taskId]) {
                tasksStore[taskId].status = 'FINISHED';
            }
        },
        getAppVersion: function () { return "1.126"; },
        getBuildTimestamp: function () { return "2026-10-25"; },
        getDeviceId: function () { return "local-android-device-pro"; },
        isFull: function () { return true; },
        getNbrTotalCalculations: function () { return 0; },
        getNbrWeekCalculations: function () { return 0; },
        getNbrDayCalculations: function () { return 0; },
        getWeekCalculationsThreshold: function () { return 999999; },
        getDayCalculationsThreshold: function () { return 999999; },
        getTotalCalculationsThreshold: function () { return 999999; },
        setClientId: function () {},
        setUserAccessToken: function () {},
        setSubscriptionPlanLevel: function () {},
        setModalVisible: function () {},
        onModalOpen: function () {},
        onModalClose: function () {},
        onPlanChoice: function () {},
        donate: function () {
            showInPageNotice("النسخة الاحترافية (Pro) مفعلة مجاناً بالكامل!", false);
        },
        consumeIap: function () {},
        signinWithGoogle: function () {
            showInPageNotice("قاعدة البيانات المحلية مفعلة بدون الحاجة لحساب خارجي", false);
        },
        logout: function () {},
        showToast: function (msg) {
            showInPageNotice(msg, false);
        },
        showProgressDialog: function (msg) {
            showInPageNotice(msg, false);
        },
        dismissProgressDialog: function () {},
        saveCsv: function (csvContent, filename) {
            try {
                var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
                download(blob, filename || 'cutlist.csv', 'text/csv');
                showInPageNotice("تم حفظ ملف CSV: " + (filename || 'cutlist.csv'), false);
            } catch (e) {
                console.error("saveCsv error:", e);
            }
        },
        saveImage: function (imgDataUrl, filename) {
            try {
                download(imgDataUrl, filename || 'cutlist.jpeg', 'image/jpeg');
                showInPageNotice("تم حفظ الصورة: " + (filename || 'cutlist.jpeg'), false);
            } catch (e) {
                console.error("saveImage error:", e);
            }
        },
        savePdf: function (pdfDataUrl, filename) {
            try {
                download(pdfDataUrl, filename || 'cutlist.pdf', 'application/pdf');
                showInPageNotice("تم حفظ ملف PDF: " + (filename || 'cutlist.pdf'), false);
            } catch (e) {
                console.error("savePdf error:", e);
            }
        }
    };

    try {
        localStorage.setItem("isFull", "true");
        localStorage.setItem("useLocalStorageAsRepository", "true");
    } catch (e) {}
})();
