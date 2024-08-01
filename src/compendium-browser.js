﻿/* eslint-disable valid-jsdoc */
/* eslint-disable complexity */
/**
 * @author Felix Müller aka syl3r86
 * @version 0.2.0
 */
/** @author Jeffrey Pugh aka @spetzel2020
 * @version 0.4
 */
/*
4-Feb-2020  0.4.0   Switch to not pre-loading the indexes, and instead do that at browsing time, to reduce server load and memory usage
                    Refactor some of the eslint warnings
5-Feb-2021          Don't do memory allocation - just browse compendia in real-time
                    After this, next step would be incremental (lazy) loading  
7-Feb-2021  0.4.1   Move load back to "ready" hook, but limit number loaded
8-Feb-2021  0.4.1   Bug fix: initialize() was setting this.spells, not this.items so CB was using twice the memory (once loaded incorrectly into this.spells
                    and once loaded on first getData() into this.items)
            0.4.1b  SpellBrowser -> CompendiumBrowser    
9-Feb-2021  0.4.1b  Call loadAndFilterItems instead of loadItems; filter as we go, limited by numToPreload   
            0.4.1c  Needed to pass specific spellFilters, itemFilters etc.    
            0.4.1d: Fixed img observer on replaced spellData        
11-Feb-2021 0.4.1e: Don't save the filter data (which is most of the memory) and remove the preload limit; instead just save the minimal amount of data     
            0.4.1g: Generalize the spell list reload and confirm spells still working   
            0.4.1h: Add the partials for npc, feat, item and the backing code    
12-Feb-2021 0.4.1j: Correct compactItem for feats and items required display items   
                    Rename itemType -> browserTab to differentiate candidate item's type from the tab it appears on (spell, feat/class, item, NPC)  
                    Fixed: Was calling the wrong sort for feat and NPC    
            0.4.1k: Don't call loadItems() during initalize; getData() just displays static elements    
            0.4.1l: Display progress indicator for loading - for now just a static one    
15-Feb-2021 0.4.2:  Fix NPCs to use loadAndFilterNpcs
            0.4.2b: Add Loading... message for NPCs
            0.4.2c: Correct Loading... message on initial tab, but not on tab switch
            0.4.2d: Display the type of item being loaded
16-Dec-2021 0.4.2f: Change preload to maxLoaded and display a message to filter if you want more      
10-Mar-2021 0.4.3: activateItemListListeners(): Remove spurious li.parents (wasn't being used anyway)    
11-Mar-2021 0.4.3  Fixed: Reset Filters doesn't clear the on-screen filter fields (because it is not completely re-rendering like it used to) Issue #4  
                    Hack solution is to re-render whole dialog which unfortunately loses filter settings on other tabs as well
            0.4.3b: Clear all filters to match displayed   
15-Mar-2021 0.4.5:  Fix: Spells from non-system compendium show up in items tab. Issue#10   
                    loadAndFilterItems(): Changed tests to switch + more explicit tests   
            0.4.5b  Show compendium source in results issue#11                                       
                    Try showing compendium in the image mouseover
12-Jun-2021 0.5.0   Test for Foundry 0.8.x in which creature type is now data.details.type.value                    
9-Spt-2021  CHANGES Removed functions that are disabled in Foundry 0.9.0
                    Speed up on spells by using queries
                    Stops already in progress searches if a new one is started
                    Handles monster types from older revisions
                    Uses some built-ins for minor performance improvement
12-Sep-2021 0.7.1   Issue #25 Initialization fails because of corrupted settings 
                    Fix: Check for settings.loadedSpellCompendium and settings.loadedNpcCompendium                   
1-Jan-2022 0.7.2    Switch to isFoundryV8Plus class variable
4-Jan-2022  0.7.2   Merge PR #33 (thanks kyleady) to improve NPC filtering performance
            0.7.2c  Fix rarity encoding (uses camelcase names) (Issue #28)
                    Check for data.details?.cr in case you have NPCs without details (type=character)
                    Change message to "Loading..." until we're done, then "Loaded"
5-Jan-2022  0.7.2d  decorateNpc(): NPCs without all details or weirdly formed ones should default damageDealt to [] not 0 
13-Sep-2022 0.8.0   Compatibility with Foundry V10
                    Added check for Compendium Folders 'phantom' actors (#[tempEntity]) to filter out of NPC list
                    Fix to handle un-migrated compendiums (they get auto-excluded from the browser even if selected)
*/

const CMPBrowser = {
    MODULE_NAME : "compendium-browser",
    MODULE_VERSION : "0.8.0",
    MAXLOAD : 500,      //Default for the maximum number to load before displaying a message that you need to filter to see more
}

const STOP_SEARCH = 'StopSearchException';

// JV-080 - Adding a 'not-migrated' exception for v10 if the compendiums are not migrated to the new format (breaks e.g. npc compendium browser)
const NOT_MIGRATED = 'NotMigratedException';

Handlebars.registerHelper('isInSet', function (inSet, value) {
    return inSet.has(value);
});

class CompendiumBrowser extends Application {

    static get defaultOptions() {
        const options = super.defaultOptions;
        foundry.utils.mergeObject(options, {
            title: "CMPBrowser.compendiumBrowser",
            tabs: [{navSelector: ".tabs", contentSelector: ".content", initial: "spell"}],
            classes: options.classes.concat('compendium-browser'),
            template: "modules/compendium-browser/template/template.hbs",
            width: 800,
            height: 700,
            resizable: true,
            minimizable: true
        });
        return options;
    }

    async initialize() {
        // load settings
        if (this.settings === undefined) {
            this.initSettings();
        } 

        await loadTemplates([
            "modules/compendium-browser/template/spell-browser.hbs",
            "modules/compendium-browser/template/spell-browser-list.hbs",       
            "modules/compendium-browser/template/npc-browser.hbs",
            "modules/compendium-browser/template/npc-browser-list.hbs",
            "modules/compendium-browser/template/feat-browser.hbs",
            "modules/compendium-browser/template/feat-browser-list.hbs",
            "modules/compendium-browser/template/item-browser.hbs",
            "modules/compendium-browser/template/item-browser-list.hbs",
            "modules/compendium-browser/template/filter-container.hbs",
            "modules/compendium-browser/template/settings.hbs",
            "modules/compendium-browser/template/loading.hbs"
        ]);


        this.hookCompendiumList();
        
        //Reset the filters used in the dialog
        this.spellFilters = {
            registeredFilterCategorys: {},
            activeFilters: {}
        };
        this.npcFilters = {
            registeredFilterCategorys: {},
            activeFilters: {}
        };
        this.featFilters = {
            registeredFilterCategorys: {},
            activeFilters: {}
        };
        this.itemFilters = {
            registeredFilterCategorys: {},
            activeFilters: {}
        };
    }


    /** override */
    _onChangeTab(event, tabs, active) {
        super._onChangeTab(event, tabs, active);
        const html = this.element;
        this.replaceList(html, active, {reload : false})
    }


    /** override */
    async getData() {   

        //0.4.1 Filter as we load to support new way of filtering
        //Previously loaded all data and filtered in place; now loads minimal (preload) amount, filtered as we go
        //First time (when you press Compendium Browser button) is called with filters unset
 
        //0.4.1k: Don't do any item/npc loading until tab is visible
        let data = {
            items : [],
            npcs: [],
            spellFilters : this.spellFilters,
            showSpellBrowser : (game.user.isGM || this.settings.allowSpellBrowser),
            featFilters : this.featFilters,
            showFeatBrowser : (game.user.isGM || this.settings.allowFeatBrowser),
            itemFilters : this.itemFilters,
            showItemBrowser : (game.user.isGM || this.settings.allowItemBrowser),
            npcFilters : this.npcFilters,
            showNpcBrowser : (game.user.isGM || this.settings.allowNpcBrowser),
            settings : this.settings,
            isGM : game.user.isGM
        };


        return data;
    }

    activateItemListListeners(html) {
        // show entity sheet
        html.find('.item-edit').click(ev => {
            let itemId = $(ev.currentTarget).parents("li").attr("data-entry-id");
            let compendium = $(ev.currentTarget).parents("li").attr("data-entry-compendium");
            let pack = game.packs.find(p => p.collection === compendium);
            pack.getDocument(itemId).then(entity => {
                entity.sheet.render(true);
            });
        });

        // make draggable
        //0.4.1: Avoid the game.packs lookup
        html.find('.draggable').each((i, li) => {
            li.setAttribute("draggable", true);
            li.addEventListener('dragstart', event => {
                let packName = li.getAttribute("data-entry-compendium");
                let pack = game.packs.find(p => p.collection === packName);
                if (!pack) {
                    event.preventDefault();
                    return false;
                }
                if (CompendiumBrowser.isFoundryV10Plus) {
                    event.dataTransfer.setData("text/plain", JSON.stringify({
                        type: pack.documentName,
                        uuid: `Compendium.${pack.collection}.${li.getAttribute("data-entry-id")}`
                      }));
                } else {
                    event.dataTransfer.setData("text/plain", JSON.stringify({
                        type: pack.documentName,
                        pack: pack.collection,
                        id: li.getAttribute("data-entry-id")
                    }));
                }
            }, false);
        });
    }

    /** override */
    activateListeners(html) {
        super.activateListeners(html);

        this.observer = new IntersectionObserver((entries, observer) => {
            for (let e of entries) {
                if (!e.isIntersecting) continue;
                const img = e.target;
                // Avatar image
                //const img = li.querySelector("img");
                if (img && img.dataset.src) {
                    img.src = img.dataset.src;
                    delete img.dataset.src;
                }

                // No longer observe the target
                observer.unobserve(e.target);
            }
        });

        this.activateItemListListeners(html);

        // toggle visibility of filter containers
        html.find('.filtercontainer h3, .multiselect label').click(async ev => {
            await $(ev.target.nextElementSibling).toggle(100);

        });
        html.find('.multiselect label').trigger('click');

        // sort spell list
        html.find('.spell-browser select[name=sortorder]').on('change', ev => {
            let spellList = html.find('.spell-browser li');
            let byName = (ev.target.value == 'true');
            let sortedList = this.sortSpells(spellList, byName);
            let ol = $(html.find('.spell-browser ul'));
            ol[0].innerHTML = [];
            for (let element of sortedList) {
                ol[0].append(element);
            }
        });
        this.triggerSort(html, "spell");

        // sort feat list in place
        html.find('.feat-browser select[name=sortorder]').on('change', ev => {
            let featList = html.find('.feat-browser li');
            let byName = (ev.target.value == 'true');
            let sortedList = this.sortFeats(featList, byName);
            let ol = $(html.find('.feat-browser ul'));
            ol[0].innerHTML = [];
            for (let element of sortedList) {
                ol[0].append(element);
            }
        });
        this.triggerSort(html, "feat");

        // sort item list in place
        html.find('.item-browser select[name=sortorder]').on('change', ev => {
            let itemList = html.find('.item-browser li');
            let byName = (ev.target.value == 'true');
            let sortedList = this.sortItems(itemList, byName);
            let ol = $(html.find('.item-browser ul'));
            ol[0].innerHTML = [];
            for (let element of sortedList) {
                ol[0].append(element);
            }
        });
        this.triggerSort(html, "item");

        // sort npc list in place
        html.find('.npc-browser select[name=sortorder]').on('change', ev => {
            let npcList = html.find('.npc-browser li');
            let orderBy = ev.target.value;
            let sortedList = this.sortNpcs(npcList, orderBy);
            let ol = $(html.find('.npc-browser ul'));
            ol[0].innerHTML = [];
            for (let element of sortedList) {
                ol[0].append(element);
            }
        });
        this.triggerSort(html, "npc");

        for (let tab of ["spell", "feat", "item", "npc"]){
            // reset filters and re-render
            //0.4.3: Reset ALL filters because when we do a re-render it affects all tabs
            html.find(`#reset-${tab}-filter`).click(ev => {
                this.resetFilters();
                //v0.4.3: Re-render so that we display the filters correctly
                this.refreshList = tab;
                this.render();
            });

        }

        // settings
        html.find('.settings input').on('change', ev => {
            let setting = ev.target.dataset.setting;
            let value = ev.target.checked;
            if (setting === 'spell-compendium-setting') {
                let key = ev.target.dataset.key;
                this.settings.loadedSpellCompendium[key].load = value;
                this.render();
                ui.notifications.info("Settings Saved. Item Compendiums are being reloaded.");
            } else if (setting === 'npc-compendium-setting') {
                let key = ev.target.dataset.key;
                this.settings.loadedNpcCompendium[key].load = value;
                this.render();
                ui.notifications.info("Settings Saved. NPC Compendiums are being reloaded.");
            }
            if (setting === 'allow-spell-browser') {
                this.settings.allowSpellBrowser = value;
            }
            if (setting === 'allow-feat-browser') {
                this.settings.allowFeatBrowser = value;
            }
            if (setting === 'allow-item-browser') {
                this.settings.allowItemBrowser = value;
            }
            if (setting === 'allow-npc-browser') {
                this.settings.allowNpcBrowser = value;
            }
            this.saveSettings();
        });


        // activating or deactivating filters
        //0.4.1: Now does a re-load and updates just the data side
        // text filters
        html.find('.filter[data-type=text] input, .filter[data-type=text] select').on('keyup change paste', ev => {
            const path = $(ev.target).parents('.filter').data('path');
            const key = stripDotCharacters(path);
            const value = ev.target.value;
            const browserTab = $(ev.target).parents('.tab').data('tab');

            const filterTarget = `${browserTab}Filters`;

            if (value === '' || value === undefined) {
                delete this[filterTarget].activeFilters[key];
            } else {
                this[filterTarget].activeFilters[key] = {
                    path: path,
                    type: 'text',
                    valIsArray: false,
                    value: ev.target.value
                }
            }

            this.replaceList(html, browserTab);   
        });

        // select filters
        html.find('.filter[data-type=select] select, .filter[data-type=bool] select, .filter[data-type=checkArray] select').on('change', ev => {
            const path = $(ev.target).parents('.filter').data('path');
            const key = stripDotCharacters(path);
            const filterType = $(ev.target).parents('.filter').data('type');
            const browserTab = $(ev.target).parents('.tab').data('tab');
            let valIsArray = $(ev.target).parents('.filter').data('valisarray');
            if (valIsArray === 'true') valIsArray = true;
            let value = ev.target.value;
            if (value === 'false') value = false;
            if (value === 'true') value = true;

            const filterTarget = `${browserTab}Filters`;

            if (value === "null") {
                delete this[filterTarget].activeFilters[key]
            } else {
                this[filterTarget].activeFilters[key] = {
                    path: path,
                    type: filterType,
                    valIsArray: valIsArray,
                    value:value
                }
            }

            this.replaceList(html, browserTab);
        });

        // multiselect filters
        html.find('.filter[data-type=multiSelect] input').on('change', ev => {
            const path = $(ev.target).parents('.filter').data('path');
            const key = stripDotCharacters(path);
            const filterType = 'multiSelect';
            const browserTab = $(ev.target).parents('.tab').data('tab');
            let valIsArray = $(ev.target).parents('.filter').data('valisarray');
            if (valIsArray === 'true') valIsArray = true;
            let value = $(ev.target).data('value');

            const filterTarget = `${browserTab}Filters`;
            const filter = this[filterTarget].activeFilters[key];

            if (ev.target.checked === true) {
                if (filter === undefined) {
                    this[filterTarget].activeFilters[key] = {
                        path: path,
                        type: filterType,
                        valIsArray: valIsArray,
                        values: [value]
                    }
                } else {
                    this[filterTarget].activeFilters[key].values.push(value);
                }
            } else {
                delete this[filterTarget].activeFilters[key].values.splice(this[filterTarget].activeFilters[key].values.indexOf(value),1);
                if (this[filterTarget].activeFilters[key].values.length === 0) {
                    delete this[filterTarget].activeFilters[key];
                }
            }

            this.replaceList(html, browserTab);   
        });


        html.find('.filter[data-type=numberCompare] select, .filter[data-type=numberCompare] input').on('change keyup paste', ev => {
            const path = $(ev.target).parents('.filter').data('path');
            const key = stripDotCharacters(path);
            const filterType = 'numberCompare';
            const browserTab = $(ev.target).parents('.tab').data('tab');
            let valIsArray = false;

            const operator = $(ev.target).parents('.filter').find('select').val();
            const value = $(ev.target).parents('.filter').find('input').val();

            const filterTarget = `${browserTab}Filters`;

            if (value === '' || operator === 'null') {
                delete this[filterTarget].activeFilters[key]
            } else {
                this[filterTarget].activeFilters[key] = {
                    path: path,
                    type: filterType,
                    valIsArray: valIsArray,
                    operator: operator,
                    value: value
                }
            }

            this.replaceList(html, browserTab);
        });

        //Just for the loading image
        if (this.observer) { 
            html.find("img").each((i,img) => this.observer.observe(img));
        }
    }

    async checkListsLoaded() {
        //Provides extra info not in the standard SRD, like which classes can learn a spell
        if (!this.classList) {
            this.classList = await fetch('modules/compendium-browser/spell-classes.json').then(result => {
                return result.json();
            }).then(obj => {
                return this.classList = obj;
            });
        }

        if (!this.packList) {
            this.packList = await fetch('modules/compendium-browser/item-packs.json').then(result => {
                return result.json();
            }).then(obj => {
                return this.packList = obj;
            });
        }

        if (!this.subClasses) {
            this.subClasses = await fetch('modules/compendium-browser/sub-classes.json').then(result => {
                return result.json();
            }).then(obj => {
                return this.subClasses = obj;
            });
        }
    }

    async loadAndFilterItems(browserTab="spell",updateLoading=null) {
        console.log(`Load and Filter Items | Started loading ${browserTab}s`);
        console.time("loadAndFilterItems");
        await this.checkListsLoaded();

        const seachNumber = Date.now();

        this.CurrentSeachNumber = seachNumber;

        const maxLoad = game.settings.get(CMPBrowser.MODULE_NAME, "maxload") ?? CMPBrowser.MAXLOAD;

        //0.4.1: Load and filter just one of spells, feats, and items (specified by browserTab)
        let unfoundSpells = '';
        let numItemsLoaded = 0;
        let compactItems = {};
        const Features = ["feat","class","subclass", "background", "race"];
        const NotItems = ["spell", "feat","class","subclass", "background", "race"];

        try{
            //Filter the full list, but only save the core compendium information + displayed info 
            for (let pack of game.packs) {
                if (pack.documentName === "Item" && this.settings.loadedSpellCompendium[pack.collection].load) {
                    //can query just for spells since there is only 1 type
                    let query = {};
                    if (browserTab === "spell") {
                        query = {type: "spell"};
                    }

                    //FIXME: How much could we do with the loaded index rather than all content? 
                    //OR filter the content up front for the decoratedItem.type??
                    await pack.getDocuments(query).then(content => {

                        if (browserTab === "spell"){

                            content.reduce(function(itemsList, item5e) {
                                if (this.CurrentSeachNumber != seachNumber) throw STOP_SEARCH;

                                numItemsLoaded = Object.keys(itemsList).length;

                                if (maxLoad <= numItemsLoaded) {
                                    if (updateLoading) {updateLoading(numItemsLoaded, true);}
                                    throw STOP_SEARCH;
                                }

                                const decoratedItem = this.decorateItem(item5e);

                                if(decoratedItem && this.passesFilter(decoratedItem, this.spellFilters.activeFilters)){
                                    itemsList[item5e.id] = {
                                        compendium : pack.collection,
                                        name : decoratedItem.name,
                                        img: decoratedItem.img,
                                        data : {
                                            level : decoratedItem.level,
                                            components : decoratedItem.components,
                                            properties: decoratedItem.system.properties
                                        },
                                        id: item5e.id
                                    };
                                }

                                return itemsList;
                            }.bind(this), compactItems);

                        }
                        else if (browserTab === "feat"){

                            content.reduce(function(itemsList, item5e){
                                if (this.CurrentSeachNumber != seachNumber) throw STOP_SEARCH;

                                numItemsLoaded = Object.keys(itemsList).length;

                                if (maxLoad <= numItemsLoaded) {
                                    if (updateLoading) {updateLoading(numItemsLoaded, true);}
                                    throw STOP_SEARCH;
                                }

                                const decoratedItem = this.decorateItem(item5e);

                                if(decoratedItem && Features.includes(decoratedItem.type) && this.passesFilter(decoratedItem, this.featFilters.activeFilters)){
                                    itemsList[item5e.id] = {
                                        compendium : pack.collection,
                                        name : decoratedItem.name,
                                        img: decoratedItem.img,
                                        classRequirementString : decoratedItem.classRequirementString
                                    };
                                }

                                return itemsList;
                            }.bind(this), compactItems);

                        }
                        else if (browserTab === "item"){

                            content.reduce(function(itemsList, item5e){
                                if (this.CurrentSeachNumber != seachNumber) throw STOP_SEARCH;

                                numItemsLoaded = Object.keys(itemsList).length;

                                if (maxLoad <= numItemsLoaded) {
                                    if (updateLoading) {updateLoading(numItemsLoaded, true);}
                                    throw STOP_SEARCH;
                                }

                                const decoratedItem = this.decorateItem(item5e);

                                if(decoratedItem && !NotItems.includes(decoratedItem.type) && this.passesFilter(decoratedItem, this.itemFilters.activeFilters)){
                                    itemsList[item5e.id] = {
                                        compendium : pack.collection,
                                        name : decoratedItem.name,
                                        img: decoratedItem.img,
                                        type : decoratedItem.type
                                    }
                                }

                                return itemsList;
                            }.bind(this), compactItems);

                        }

                        numItemsLoaded = Object.keys(compactItems).length;
                        if (updateLoading) {updateLoading(numItemsLoaded, false);}
                    });
                }//end if pack entity === Item
            }//for packs
        }
        catch(e){
            if (e === STOP_SEARCH){
                //stopping search early
            }
            else{
                throw e;
            }
        }

        // this.removeDuplicates(compactItems);
/*

        if (unfoundSpells !== '') {
            console.log(`Load and Fliter Items | List of Spells that don't have a class associated to them:`);
            console.log(unfoundSpells);
        }      
*/
        this.itemsLoaded = true;  
        console.timeEnd("loadAndFilterItems");
        console.log(`Load and Filter Items | Finished loading ${Object.keys(compactItems).length} ${browserTab}s`);
        updateLoading(numItemsLoaded, true)
        return compactItems;
    }

    async loadAndFilterNpcs(updateLoading=null) {
        console.log('NPC Browser | Started loading NPCs');

        const seachNumber = Date.now();
        this.CurrentSeachNumber = seachNumber;

        console.time("loadAndFilterNpcs");
        let npcs = {};

        const maxLoad = game.settings.get(CMPBrowser.MODULE_NAME, "maxload") ?? CMPBrowser.MAXLOAD;

        let numNpcsLoaded = 0;
        this.npcsLoaded = false;


        // fields required for displaying and decorating NPCs
        let requiredIndexFields;

        if (CompendiumBrowser.isFoundryV11Plus){
            requiredIndexFields = [
                'name',
                'img',
                'system.details.cr',
                'system.traits.size',
                'system.details.type.value',
              ]
        }
        else if (CompendiumBrowser.isFoundryV10Plus)
        {
            requiredIndexFields = [
                'name',
                'img',
                'system.details.cr',
                'system.traits.size',
                'system.details.type',
                'items.type',
                'items.system.damage.parts',
              ]
      
        }
        else{
            requiredIndexFields = [
              'name',
              'img',
              'data.details.cr',
              'data.traits.size',
              'data.details.type',
              'items.type',
              'items.system.damage.parts',
            ];
        }
        // add any fields required for currently active filters
        //also remove the duplicate fields for sanity
        const indexFields = [...new Set(requiredIndexFields.concat(
                                        Object.values(this.npcFilters.activeFilters).map(f => f.path)
                                    ))];
        let collectionName = "unknown";
        try{
            for (let pack of game.packs) {
                if (pack.documentName == "Actor" && this.settings.loadedNpcCompendium[pack.collection].load) {
                    await pack.getIndex({fields: indexFields}).then(async content => {
                        content.reduce(function(actorsList, npc5e){
                            if (this.CurrentSeachNumber != seachNumber) {throw STOP_SEARCH;}

                            // JV-080: We're in a v10 foundry but the data doesn't have Actor#system - this means index fields won't have populated. Can't 'browse' like this. 
                            if (CompendiumBrowser.isFoundryV10Plus && npc5e.system == undefined) {collectionName = pack.collection; throw NOT_MIGRATED;}

                            numNpcsLoaded = Object.keys(npcs).length;

                            if (maxLoad <= numNpcsLoaded) {
                                if (updateLoading) {updateLoading(numNpcsLoaded, true);}
                                throw STOP_SEARCH;
                            }
                            // JV-080: Special case. Compendium Folders creates Actors called #[CF_tempEntity] as placeholders for it's functions. Avoid them
                            if (npc5e.name != "#[CF_tempEntity]") {
                                const decoratedNpc = this.decorateNpc(npc5e, indexFields);
                                if (decoratedNpc && this.passesFilter(decoratedNpc, this.npcFilters.activeFilters)){

                                    actorsList[npc5e._id] = {
                                        compendium : pack.collection,
                                        name : decoratedNpc.name,
                                        img: decoratedNpc.img,
                                        displayCR : decoratedNpc.displayCR,
                                        displaySize : decoratedNpc.displaySize,
                                        displayType: decoratedNpc.displayType,
                                        orderCR : decoratedNpc.orderCR,
                                        orderSize : decoratedNpc.filterSize
                                    };
                                }
                            }
                            return actorsList;
                        }.bind(this), npcs);

                        numNpcsLoaded = Object.keys(npcs).length;
                        if (updateLoading) {updateLoading(numNpcsLoaded, false);}

                    });
                }
               //0.4.1 Only preload a limited number and fill more in as needed
            }
        }
        catch(e){
            if (e == STOP_SEARCH){
                //breaking out
            }
            else if (e == NOT_MIGRATED){
                console.log("Cannot browse compendium %s as it is not migrated to v10 format",collectionName);
            }
            else{
                console.timeEnd("loadAndFilterNpcs");
                throw e;
            }
        }

        this.npcsLoaded = true;
        console.timeEnd("loadAndFilterNpcs");
        console.log(`NPC Browser | Finished loading NPCs: ${Object.keys(npcs).length} NPCs`);
        updateLoading(numNpcsLoaded, true) 
        return npcs;
    }
    


    hookCompendiumList() {
        Hooks.on('renderCompendiumDirectory', (app, html, data) => {
            this.hookCompendiumList();
        });

        let html = $('#compendium');
        if (this.settings === undefined) {
            this.initSettings();
        }
        if (game.user.isGM || this.settings.allowSpellBrowser || this.settings.allowNpcBrowser) {
            const cbButton = $(`<button class="compendium-browser-btn"><i class="fas fa-fire"></i> ${game.i18n.localize("CMPBrowser.compendiumBrowser")}</button>`);
            html.find('.compendium-browser-btn').remove();

            // adding to directory-list since the footer doesn't exist if the user is not gm
            html.find('.directory-footer').append(cbButton);

            // Handle button clicks
            cbButton.click(ev => {
                ev.preventDefault();
                //0.4.1: Reset filters when you click button
                this.resetFilters();
                //0.4.3: Reset everything (including data) when you press the button - calls afterRender() hook
                 
                if (game.user.isGM || this.settings.allowSpellBrowser) {
                    this.refreshList = "spell";
                } else if (this.settings.allowFeatBrowser) {
                    this.refreshList = "feat";
                } else if (this.settings.allowItemBrowser) {
                    this.refreshList = "item";
                } else if (this.settings.allowNPCBrowser) {
                    this.refreshList = "npc";
                }
                this.render(true);
            });
        }
    }



    
    /* Hook to load the first data */
    static afterRender(cb, html) {
        //0.4.3: Because a render always resets ALL the displayed filters (on all tabs) to unselected , we have to blank all the lists as well
        // (because the current HTML template doesn't set the selected filter values)
        if (!cb?.refreshList) {return;}

        cb.replaceList(html, cb.refreshList);

        cb.refreshList = null;

        if(CompendiumBrowser.postRender){
            CompendiumBrowser.postRender();
        }
    }

    resetFilters() {
        this.spellFilters.activeFilters = {};
        this.featFilters.activeFilters = {};
        this.itemFilters.activeFilters = {};
        this.npcFilters.activeFilters = {};
    }



    async replaceList(html, browserTab, options = {reload : true}) {
        //After rendering the first time or re-rendering trigger the load/reload of visible data
 
        let elements = null;
        //0.4.2 Display a Loading... message while the data is being loaded and filtered
        let loadingMessage = null;
        if (browserTab === 'spell') {
            elements = html.find("ul#CBSpells");
            loadingMessage = html.find("#CBSpellsMessage");
        } else if (browserTab === 'npc') {
            elements = html.find("ul#CBNPCs");
            loadingMessage = html.find("#CBNpcsMessage");            
        } else if (browserTab === 'feat') {
            elements = html.find("ul#CBFeats");
            loadingMessage = html.find("#CBFeatsMessage");            
        } else if (browserTab === 'item') {
            elements = html.find("ul#CBItems");
            loadingMessage = html.find("#CBItemsMessage");            
        }
        if (elements?.length) {
            //0.4.2b: On a tab-switch, only reload if there isn't any data already 
            if (options?.reload || !elements[0].children.length) {

                const maxLoad = game.settings.get(CMPBrowser.MODULE_NAME, "maxload") ?? CMPBrowser.MAXLOAD;
                const updateLoading = async (numLoaded,doneLoading) => {
                    if (loadingMessage.length) {this.renderLoading(loadingMessage[0], browserTab, numLoaded, numLoaded>=maxLoad, doneLoading);}
                }
                updateLoading(0, false);
                //Uses loadAndFilterItems to read compendia for items which pass the current filters and render on this tab
                const newItemsHTML = await this.renderItemData(browserTab, updateLoading); 
                elements[0].innerHTML = newItemsHTML;
                //Re-sort before setting up lazy loading
                this.triggerSort(html, browserTab);

                //Lazy load images
                if (this.observer) { 
                    $(elements).find("img").each((i,img) => this.observer.observe(img));
                }

                //Reactivate listeners for clicking and dragging
                this.activateItemListListeners($(elements));
            }
        }

    }

    async renderLoading(messageElement, itemType, numLoaded, maxLoaded=false, doneLoading=false) {
        if (!messageElement) return;

        let loadingHTML = await renderTemplate("modules/compendium-browser/template/loading.hbs", {numLoaded: numLoaded, itemType: itemType, maxLoaded: maxLoaded, doneLoading: doneLoading});
        messageElement.innerHTML = loadingHTML;
    }

    async renderItemData(browserTab, updateLoading=null) {
        let listItems;
        if (browserTab === "npc") {
            listItems = await this.loadAndFilterNpcs(updateLoading);
        } else {
            listItems = await this.loadAndFilterItems(browserTab, updateLoading);
        }
        const html = await renderTemplate(`modules/compendium-browser/template/${browserTab}-browser-list.hbs`, {listItems : listItems})

        return html;
    }

    //SORTING
    triggerSort(html, browserTab) {
        if (browserTab === 'spell') {
            html.find('.spell-browser select[name=sortorder]').trigger('change');
        } else if (browserTab === 'feat') {
            html.find('.feat-browser select[name=sortorder]').trigger('change');
        } else if (browserTab === 'npc') {
            html.find('.npc-browser select[name=sortorder]').trigger('change')
        } else if (browserTab === 'item') {
            html.find('.item-browser select[name=sortorder]').trigger('change');
        }
    }



    sortSpells(list, byName) {
        if (byName) {
            list.sort((a, b) => {
                let aName = $(a).find('.item-name a')[0].innerHTML;
                let bName = $(b).find('.item-name a')[0].innerHTML;
                if (aName < bName) return -1;
                if (aName > bName) return 1;
                return 0;
            });
        } else {
            list.sort((a, b) => {
                let aVal = $(a).find('input[name=level]').val();
                let bVal = $(b).find('input[name=level]').val();
                if (aVal < bVal) return -1;
                if (aVal > bVal) return 1;
                if (aVal == bVal) {
                    let aName = $(a).find('.item-name a')[0].innerHTML;
                    let bName = $(b).find('.item-name a')[0].innerHTML;
                    if (aName < bName) return -1;
                    if (aName > bName) return 1;
                    return 0;
                }
            });
        }
        return list;
    }

    sortFeats(list, byName) {
        if (byName) {
            list.sort((a, b) => {
                let aName = $(a).find('.item-name a')[0].innerHTML;
                let bName = $(b).find('.item-name a')[0].innerHTML;
                if (aName < bName) return -1;
                if (aName > bName) return 1;
                return 0;
            });
        } else {
            list.sort((a, b) => {
                let aVal = $(a).find('input[name=class]').val();
                let bVal = $(b).find('input[name=class]').val();
                if (aVal < bVal) return -1;
                if (aVal > bVal) return 1;
                if (aVal == bVal) {
                    let aName = $(a).find('.item-name a')[0].innerHTML;
                    let bName = $(b).find('.item-name a')[0].innerHTML;
                    if (aName < bName) return -1;
                    if (aName > bName) return 1;
                    return 0;
                }
            });
        }
        return list;
    }

    sortItems(list, byName) {
        if (byName) {
            list.sort((a, b) => {
                let aName = $(a).find('.item-name a')[0].innerHTML;
                let bName = $(b).find('.item-name a')[0].innerHTML;
                if (aName < bName) return -1;
                if (aName > bName) return 1;
                return 0;
            });
        } else {
            list.sort((a, b) => {
                let aVal = $(a).find('input[name=type]').val();
                let bVal = $(b).find('input[name=type]').val();
                if (aVal < bVal) return -1;
                if (aVal > bVal) return 1;
                if (aVal == bVal) {
                    let aName = $(a).find('.item-name a')[0].innerHTML;
                    let bName = $(b).find('.item-name a')[0].innerHTML;
                    if (aName < bName) return -1;
                    if (aName > bName) return 1;
                    return 0;
                }
            });
        }
        return list;
    }

    sortNpcs(list, orderBy) {
        switch (orderBy) {
            case 'name':
                list.sort((a, b) => {
                    let aName = $(a).find('.npc-name a')[0].innerHTML;
                    let bName = $(b).find('.npc-name a')[0].innerHTML;
                    if (aName < bName) return -1;
                    if (aName > bName) return 1;
                    return 0;
                }); break;
            case 'cr':
                list.sort((a, b) => {
                    let aVal = Number($(a).find('input[name="order.cr"]').val());
                    let bVal = Number($(b).find('input[name="order.cr"]').val());
                    if (aVal < bVal) return -1;
                    if (aVal > bVal) return 1;
                    if (aVal == bVal) {
                        let aName = $(a).find('.npc-name a')[0].innerHTML;
                        let bName = $(b).find('.npc-name a')[0].innerHTML;
                        if (aName < bName) return -1;
                        if (aName > bName) return 1;
                        return 0;
                    }
                }); break;
            case 'size':
                list.sort((a, b) => {
                    let aVal = $(a).find('input[name="order.size"]').val();
                    let bVal = $(b).find('input[name="order.size"]').val();
                    if (aVal < bVal) return -1;
                    if (aVal > bVal) return 1;
                    if (aVal == bVal) {
                        let aName = $(a).find('.npc-name a')[0].innerHTML;
                        let bName = $(b).find('.npc-name a')[0].innerHTML;
                        if (aName < bName) return -1;
                        if (aName > bName) return 1;
                        return 0;
                    }
                }); break;
        }
        return list;
    }

    decorateItem(item5e) {
        if (!item5e) return null;
        //Decorate and then filter a compendium entry - returns null or the item

        //JV-080 - v10 does away with item.data and everything is under #system but we want to decorate the first level of the item for return
        const item = {...item5e}

        //JV-080: Folding these down to base item.x level so we can have v10 Item#system coexist with v9- Item
        if (CompendiumBrowser.isFoundryV10Plus) {
            item.level = item5e.system?.level;
            item.components = item5e.system?.components;
            item.damage = item5e.system?.damage;
            item.classes = item5e.system?.classes;
            item.requirements = item5e.system?.requirements;
        }
        else {
            item = item5e.data;
            item.level = item5e.data?.level;
            item.components = item5e.data?.level;
            item.damage = item.data?.damage;       // equivalent to: item5e.data.data.xxx - Ugh. The 'fold down' in v10 makes sense now. 
            item.classes = item.data?.classes;
            item.requirements = item.data?.requirements;
        }
        // getting damage types (common to all Items, although some won't have any)
        item.damageTypes = [];

        if (item.damage && item.damage.parts.length > 0) {
            for (let part of item.damage.parts) {
                let type = part[1];
                if (item.damageTypes.indexOf(type) === -1) {
                    item.damageTypes.push(type);
                }
            }
        }

        if (item.type === 'spell') {
            // determining classes that can use the spell
            let cleanSpellName = item.name.toLowerCase().replace(/[^一-龠ぁ-ゔァ-ヴーa-zA-Z0-9ａ-ｚＡ-Ｚ０-９々〆〤]/g, '').replace("'", '').replace(/ /g, '');
            //let cleanSpellName = spell.name.toLowerCase().replace(/[^a-zA-Z0-9\s:]/g, '').replace("'", '').replace(/ /g, '');
            if (this.classList[cleanSpellName]) {
                let classes = this.classList[cleanSpellName];
                item.classes = classes.split(',');
            } else {
                //FIXME: unfoundSpells += cleanSpellName + ',';
            }
        } else  if (item.type === 'feat' || item.type === 'class') {
            // getting class
            let reqString = item.requirements?.replace(/[0-9]/g, '').trim();
            let matchedClass = [];
            for (let c in this.subClasses) {
                if (reqString && reqString.toLowerCase().indexOf(c) !== -1) {
                    matchedClass.push(c);
                } else {
                    for (let subClass of this.subClasses[c]) {
                        if (reqString && reqString.indexOf(subClass) !== -1) {
                            matchedClass.push(c);
                            break;
                        }
                    }
                }
            }
            item.classRequirement = matchedClass;
            item.classRequirementString = matchedClass.join(', ');

            // getting uses/ressources status
            item.usesRessources = item5e.hasLimitedUses;

            //JV-080: In v10 this is only a getter (and will already exist since item = item5e.system)
            if (!CompendiumBrowser.isFoundryV10Plus) {
                item.hasSave = item5e.hasSave;
            }
        } else  if (item.type === 'subclass') {
            //subclasses dont exist lower then version 10
            item.classRequirement = [item.system.classIdentifier];
            item.classRequirementString = item.system.classIdentifier
        } else {
            // getting pack
            let matchedPacks = [];
            for (let pack of Object.keys(this.packList)) {
                for (let packItem of this.packList[pack]) {
                    if (item.name.toLowerCase() === packItem.toLowerCase()) {
                        matchedPacks.push(pack);
                        break;
                    }
                }
            }
            item.matchedPacks = matchedPacks;
            item.matchedPacksString = matchedPacks.join(', ');

            // getting uses/ressources status
            item.usesRessources = item5e.hasLimitedUses
        } 
        return item;
    }

    decorateNpc(npc, indexFields) {
        try {
            const decoratedNpc = indexFields.reduce((npcDict, item) => {
                set(npcDict, item, getPropByString(npc, item))
                return npcDict
            }, {})

            //0.8.0: update for V10 to use actor.system instead of actor.data
            let npcData;

            if (CompendiumBrowser.isFoundryV10Plus){
                npcData = npc.system;
            }
            else{
                npcData = npc.data;
            }

            // cr display
            let cr = npcData.details?.cr; //0.7.2c: Possibly because of getIndex() use we now have to check for existence of details (doesn't for Character-type NPCs)
            if (cr === undefined || cr === '') cr = 0;
            else cr = Number(cr);

            // JV-080: moved here because we want the OG number for orderCR but can't depend on .details.cr being present 
            decoratedNpc.orderCR = cr;

            if (cr > 0 && cr < 1) cr = "1/" + (1 / cr);
            decoratedNpc.displayCR = cr;

            decoratedNpc.displaySize = 'unset';
            decoratedNpc.filterSize = 2;
            if (npcData.details) {
                decoratedNpc.displayType = this.getNPCType(npcData.details.type);
            }
            else {
                decoratedNpc.displayType = game.i18n.localize("CMPBrowser.Unknown") ?? "Unknown";
            }

            if (CONFIG.DND5E.actorSizes[npcData.traits.size] !== undefined) {
                if (CompendiumBrowser.isFoundryV10Plus) {
                    decoratedNpc.displaySize = CONFIG.DND5E.actorSizes[npc.system.traits.size].label;
                } else {
                    decoratedNpc.displaySize = CONFIG.DND5E.actorSizes[npc.data.traits.size].label;              
                }
            }
            let npcSize;
            if (CompendiumBrowser.isFoundryV10Plus) {
                npcSize = npc.system.traits.size;
            } else {
                npcSize = npc.data.traits.size;                
            }
            switch (npcSize) {
                case 'grg': decoratedNpc.filterSize = 5; break;
                case 'huge': decoratedNpc.filterSize = 4; break;
                case 'lg': decoratedNpc.filterSize = 3; break;
                case 'sm': decoratedNpc.filterSize = 1; break;
                case 'tiny': decoratedNpc.filterSize = 0; break;
                case 'med':
                default: decoratedNpc.filterSize = 2; break;
            }

            if (CompendiumBrowser.isFoundryV10Minus){
                // getting value for HasSpells and damage types
                decoratedNpc.hasSpells = npc.items?.type?.some(itemType => itemType === 'spell');
                let npcDamagePart;
                if (CompendiumBrowser.isFoundryV10Plus) {
                    npcDamagePart = npc.items?.system?.damage?.parts;
                } else {
                    npcDamagePart = npc.items?.data?.damage?.parts;
                }
                decoratedNpc.damageDealt = npcDamagePart ? npcDamagePart.filter(p => p?.length >= 2).map(p => p[1]) : [];
            }
            
            // JV-080: Think we have covered this off above now. We're making no assumptions and assuring that all decoratedNpc fields are now not 'undef' 
            //handle poorly constructed npc
            //if (npcData.details?.type && !(npcData.details?.type instanceof Object)){
            //    npcData.details.type = {value: npcData.details?.type};
            //}
            return decoratedNpc;
        }
        catch(e){
            console.log('%c Error loading NPC:'+npc.name, 'background: white; color: red')
            throw e;   
        }
    }

    getNPCType(type){
        if (type instanceof Object){
            return game.i18n.localize(CompendiumBrowser.CREATURE_TYPES[type.value]) ?? type.value;
        }

        return type;
    }

    filterElements(list, subjects, filters) {
        for (let element of list) {
            let subject = subjects[element.dataset.entryId];
            if (this.passesFilter(subject, filters) == false) {
                $(element).hide();
            } else {
                $(element).show();
            }
        }
    }

    passesFilter(subject, filters) {
        for (let filter of Object.values(filters)) {
            let prop = foundry.utils.getProperty(subject, filter.path);
            if (filter.type === 'numberCompare') {

                switch (filter.operator) {
                    case '=': if (prop != filter.value) { return false; } break;
                    case '<': if (prop >= filter.value) { return false; } break;
                    case '>': if (prop <= filter.value) { return false; } break;
                }

                continue;
            }
            if(filter.type === 'checkArray'){
                if (prop === undefined) return false;
                const filterSplit = filter.value.split(':');

                if(filterSplit.length < 2) return false;

                const filterValue = filterSplit[0];
                const filterCheck = filterSplit[1];

                if(filterCheck === 'Yes'){
                    if(!prop.has(filterValue)) return false;
                }
                else{
                    if(prop.has(filterValue)) return false;
                }

                continue;
            }
            if (filter.valIsArray === false) {
                if (filter.type === 'text') {
                    if (prop === undefined) return false;
                    if(filter.path === "system.details.source"){
                        if (prop.book.toLowerCase().indexOf(filter.value.toLowerCase()) === -1) {
                            return false;
                        }
                    }
                    else{
                        if (prop.toLowerCase().indexOf(filter.value.toLowerCase()) === -1) {
                            return false;
                        }
                    }
                } else {
                    if (prop === undefined) return false;
                    if (filter.value !== undefined && prop !== undefined && prop != filter.value && !(filter.value === true && prop)) {
                        return false;
                    }
                    if (filter.values && filter.values.indexOf(prop) === -1) {
                        return false;
                    }
                }
            } else {
                if (prop === undefined) return false;
                if (typeof prop === 'object') {
                    if (filter.value) {
                        if (prop.indexOf(filter.value) === -1) {
                            return false;
                        }
                    } else if (filter.values) {
                        for (let val of filter.values) {
                            if (prop.indexOf(val) !== -1) {
                                continue;
                            }
                            return false;
                        }
                    }
                } else {
                    for (let val of filter.values) {
                        if (prop === val) {
                            continue;
                        }
                    }
                    return false;
                }
            }
        }

        return true;
    }

    //incomplete removal of duplicate items
    removeDuplicates(spellList){
        //sort at n log n
        let sortedList = Object.values(spellList).sort((a, b) => a.name.localeCompare(b.name));

        //search through sorted list for duplicates
        for (let index = 0; index < sortedList.length - 1;){

            //all duplicates will be next to eachother
            if (sortedList[index].name == sortedList[index + 1].name){
                //duplicate something is getting removed
                //TODO choose what to remove rather then the second
                let remove = index + 1;

                delete spellList[sortedList[remove].id];
                sortedList.splice(remove, 1);
            }
            else{
                index++;
            }
        }
    }

    clearObject(obj) {
        let newObj = {};
        for (let key in obj) {
            if (obj[key] == true) {
                newObj[key] = true;
            }
        }
        return newObj;
    }

    initSettings() {
        let defaultSettings = {
            loadedSpellCompendium: {},
            loadedNpcCompendium: {},
        };
        for (let compendium of game.packs) {
            if (compendium.documentName === "Item") {
                defaultSettings.loadedSpellCompendium[compendium.collection] = {
                    load: true,
                    name: `${compendium['metadata']['label']} (${compendium.collection})`
                };
            }
            if (compendium.documentName === "Actor") {
                defaultSettings.loadedNpcCompendium[compendium.collection] = {
                    load: true,
                    name: `${compendium['metadata']['label']} (${compendium.collection})`
                };
            }
        }
        // creating game setting container
        game.settings.register(CMPBrowser.MODULE_NAME, "settings", {
            name: "Compendium Browser Settings",
            hint: "Settings to exclude packs from loading and visibility of the browser",
            default: defaultSettings,
            type: Object,
            scope: 'world',
            onChange: settings => {
                this.settings = settings;
            }
        });
        game.settings.register(CMPBrowser.MODULE_NAME, "maxload", {
            name: game.i18n.localize("CMPBrowser.SETTING.Maxload.NAME"),
            hint: game.i18n.localize("CMPBrowser.SETTING.Maxload.HINT"),
            scope: "world",
            config: true,
            default: CMPBrowser.MAXLOAD,
            type: Number,
            range: {             // If range is specified, the resulting setting will be a range slider
                min: 200,
                max: 5000,
                step: 100
            }
        });
        game.settings.register(CMPBrowser.MODULE_NAME, "extrabuttons", {
            name: game.i18n.localize("CMPBrowser.SETTING.ExtraButtons.NAME"),
            hint: game.i18n.localize("CMPBrowser.SETTING.ExtraButtons.HINT"),
            scope: "client",
            config: true,
            default: true,
            type: Boolean
        });
        
        // load settings from container and apply to default settings (available compendie might have changed)
        let settings = game.settings.get(CMPBrowser.MODULE_NAME, 'settings');
        for (let compKey in defaultSettings.loadedSpellCompendium) {
            //v0.7.1 Check for settings.loadedSpellCompendium
            if (settings.loadedSpellCompendium && (settings.loadedSpellCompendium[compKey] !== undefined)) {
                defaultSettings.loadedSpellCompendium[compKey].load = settings.loadedSpellCompendium[compKey].load;
            }
        }
        for (let compKey in defaultSettings.loadedNpcCompendium) {
            //v0.7.1 Check for settings.loadedNpcCompendium
            if (settings.loadedNpcCompendium && (settings.loadedNpcCompendium[compKey] !== undefined)) {
                defaultSettings.loadedNpcCompendium[compKey].load = settings.loadedNpcCompendium[compKey].load;
            }
        }
        defaultSettings.allowSpellBrowser = settings.allowSpellBrowser ? true : false;
        defaultSettings.allowFeatBrowser = settings.allowFeatBrowser ? true : false;
        defaultSettings.allowItemBrowser = settings.allowItemBrowser ? true : false;
        defaultSettings.allowNpcBrowser = settings.allowNpcBrowser ? true : false;
        
        if (game.user.isGM) {
            game.settings.set(CMPBrowser.MODULE_NAME, 'settings', defaultSettings);
            console.log("New default settings set");
            console.log(defaultSettings);
        }   
        this.settings = defaultSettings;

        //0.9.5 Set the CompendiumBrowser.isFoundryV8Plus variable for different code-paths
        //If v9, then game.data.version will throw a deprecation warning so test for v9 first
        CompendiumBrowser.isFoundryV8Plus = (game.release?.generation >= 10) || (game.data.release?.generation >= 9) || (game.data.version?.startsWith("0.8"));
        
        // If V10, we need to know this because in v10(+) Item5e#data and Actor#data have changed to Item5e#system and Actor#system
        CompendiumBrowser.isFoundryV10Plus = (game.release?.generation >= 10);
        CompendiumBrowser.isFoundryV10Minus = ((game.release?.generation <= 10) || (game.data.release?.generation <= 9) || (game.data.version?.startsWith("0.8")));

        CompendiumBrowser.isFoundryV11Plus = (game.release?.generation >= 11);
    }

    saveSettings() {
        game.settings.set(CMPBrowser.MODULE_NAME, 'settings', this.settings);
    }

    //FILTERS - Added on the Ready hook
    //0.4.0 Make this async so filters can be added all at once
    async addFilter(entityType, category, label, path, type, possibleValues = null, valIsArray = false) {

        let target = `${entityType}Filters`;
        let filter = {};
        filter.path = path;
        filter.labelId = stripSpecialCharacters(label);
        filter.label = game.i18n.localize(label) ?? label;
        filter.type = 'text';
        if (['text', 'bool', 'select', 'multiSelect', 'numberCompare'].indexOf(type) !== -1) {
            filter[`is${type}`] = true;
            filter.type = type;
        }

        if(type == "checkArray"){
            filter['isselect'] = true;
            filter.type = type;
        }

        if (possibleValues !== null) {
            
            filter.possibleValueIds = possibleValues;

            filter.possibleValues = Object.keys(possibleValues).reduce(function (acc, current) {
                if(typeof possibleValues[current] === 'object'){
                    acc[current] = game.i18n.localize(possibleValues[current].fullKey) ?? possibleValues[current].fullKey ?? game.i18n.localize(possibleValues[current].label) ?? possibleValues[current].label;
                    return acc;
                }
                else{
                    acc[current] = game.i18n.localize(possibleValues[current]) ?? possibleValues[current];
                    return acc;
                }
            }.bind(this),
            {})
        }
        filter.valIsArray = valIsArray;

        let catId = stripSpecialCharacters(category);
        if (this[target].registeredFilterCategorys[catId] === undefined) {
            this[target].registeredFilterCategorys[catId] = {
                label: game.i18n.localize(category) ?? category,
                labelId: catId,
                filters: []
            };
        }
        this[target].registeredFilterCategorys[catId].filters.push(filter);

    }

    async addSpellFilters() {
        // Spellfilters
        //Foundry v10+ Item#data is now Item#system
        if (CompendiumBrowser.isFoundryV10Plus) {

            this.addSpellFilter("CMPBrowser.general", "DND5E.Source", 'system.source.book', 'text');
            this.addSpellFilter("CMPBrowser.general", "DND5E.Level", 'system.level', 'multiSelect', {0:"DND5E.SpellCantrip", 1:"1", 2:"2", 3:"3", 4:"4", 5:"5", 6:"6", 7:"7", 8:"8", 9:"9"});
            this.addSpellFilter("CMPBrowser.general", "DND5E.SpellSchool", 'system.school', 'select', CONFIG.DND5E.spellSchools);
            this.addSpellFilter("CMPBrowser.general", "CMPBrowser.castingTime", 'system.activation.type', 'select',
                {
                    action: "DND5E.Action",
                    bonus: "DND5E.BonusAction",
                    reaction: "DND5E.Reaction",
                    minute: "DND5E.TimeMinute",
                    hour: "DND5E.TimeHour",
                    day: "DND5E.TimeDay"
                }
            );
            this.addSpellFilter("CMPBrowser.general", "CMPBrowser.spellType", 'system.actionType', 'select', CONFIG.DND5E.itemActionTypes);
            this.addSpellFilter("CMPBrowser.general", "CMPBrowser.damageType", 'damageTypes', 'select', CONFIG.DND5E.damageTypes);
            //JV-082: Fix for missing "Class" search feature
            this.addSpellFilter("CMPBrowser.general", "ITEM.TypeClass", 'classes', 'select',
                {
                    artificer: "CMPBrowser.artificer",
                    bard: "CMPBrowser.bard",
                    cleric: "CMPBrowser.cleric",
                    druid: "CMPBrowser.druid",
                    paladin: "CMPBrowser.paladin",
                    ranger: "CMPBrowser.ranger",
                    sorcerer: "CMPBrowser.sorcerer",
                    warlock: "CMPBrowser.warlock",
                    wizard: "CMPBrowser.wizard",
                }, true
            );
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.Ritual", 'system.properties', 'checkArray', {"ritual:Yes":"Yes", "ritual:No":"No"}, true);
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.Concentration", 'system.properties', 'checkArray', {"concentration:Yes":"Yes", "concentration:No":"No"}, true);
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.ComponentVerbal", 'system.properties', 'checkArray', {"vocal:Yes":"Yes", "vocal:No":"No"}, true);
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.ComponentSomatic", 'system.properties', 'checkArray', {"somatic:Yes":"Yes", "somatic:No":"No"}, true);
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.ComponentMaterial", 'system.properties', 'checkArray', {"material:Yes":"Yes", "material:No":"No"}, true);
        }
        else {
            this.addSpellFilter("CMPBrowser.general", "DND5E.Source", 'data.source.book', 'text');
            this.addSpellFilter("CMPBrowser.general", "DND5E.Level", 'data.level', 'multiSelect', {0:"DND5E.SpellCantrip", 1:"1", 2:"2", 3:"3", 4:"4", 5:"5", 6:"6", 7:"7", 8:"8", 9:"9"});
            this.addSpellFilter("CMPBrowser.general", "DND5E.SpellSchool", 'data.school', 'select', CONFIG.DND5E.spellSchools);
            this.addSpellFilter("CMPBrowser.general", "CMPBrowser.castingTime", 'data.activation.type', 'select',
                {
                    action: "DND5E.Action",
                    bonus: "DND5E.BonusAction",
                    reaction: "DND5E.Reaction",
                    minute: "DND5E.TimeMinute",
                    hour: "DND5E.TimeHour",
                    day: "DND5E.TimeDay"
                }
            );
            this.addSpellFilter("CMPBrowser.general", "CMPBrowser.spellType", 'data.actionType', 'select', CONFIG.DND5E.itemActionTypes);
            this.addSpellFilter("CMPBrowser.general", "CMPBrowser.damageType", 'damageTypes', 'select', CONFIG.DND5E.damageTypes);
            this.addSpellFilter("CMPBrowser.general", "ITEM.TypeClass", 'data.classes', 'select',
                {
                    artificer: "CMPBrowser.artificer",
                    bard: "CMPBrowser.bard",
                    cleric: "CMPBrowser.cleric",
                    druid: "CMPBrowser.druid",
                    paladin: "CMPBrowser.paladin",
                    ranger: "CMPBrowser.ranger",
                    sorcerer: "CMPBrowser.sorcerer",
                    warlock: "CMPBrowser.warlock",
                    wizard: "CMPBrowser.wizard",
                }, true
            );
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.Ritual", 'data.properties.ritual', 'bool');
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.Concentration", 'data.properties.concentration', 'bool');
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.ComponentVerbal", 'data.properties.vocal', 'bool');
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.ComponentSomatic", 'data.properties.somatic', 'bool');
            this.addSpellFilter("DND5E.SpellComponents", "DND5E.ComponentMaterial", 'data.properties.material', 'bool');
        }
    }

    async addItemFilters() {
        // Item Filters

        // Feature Filters
        //Foundry v10+ Item#data is now Item#system
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addItemFilter("CMPBrowser.general", "DND5E.Source", 'system.source.book', 'text');
        }
        else
        {
            this.addItemFilter("CMPBrowser.general", "DND5E.Source", 'data.source.book', 'text');
        }

        this.addItemFilter("CMPBrowser.general", "Item Type", 'type', 'select', {
            consumable: "ITEM.TypeConsumable",
            backpack: "ITEM.TypeContainer",
            equipment: "ITEM.TypeEquipment",
            loot: "ITEM.TypeLoot",
            tool: "ITEM.TypeTool",
            weapon: "ITEM.TypeWeapon"
        });
        this.addItemFilter("CMPBrowser.general", "CMPBrowser.ItemsPacks", 'matchedPacks', 'select',
            {
                burglar: "CMPBrowser.ItemsPacksBurglar",
                diplomat: "CMPBrowser.ItemsPacksDiplomat",
                dungeoneer: "CMPBrowser.ItemsPacksDungeoneer",
                entertainer: "CMPBrowser.ItemsPacksEntertainer",
                explorer: "CMPBrowser.ItemsPacksExplorer",
                monsterhunter: "CMPBrowser.ItemsPacksMonsterHunter",
                priest: "CMPBrowser.ItemsPacksPriest",
                scholar: "CMPBrowser.ItemsPacksScholar",
            }, true
        );
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addItemFilter("CMPBrowser.GameMechanics", "DND5E.ItemActivationCost", 'system.activation.type', 'select', CONFIG.DND5E.abilityActivationTypes);
        }
        else {
            this.addItemFilter("CMPBrowser.GameMechanics", "DND5E.ItemActivationCost", 'data.activation.type', 'select', CONFIG.DND5E.abilityActivationTypes);
        }

        this.addItemFilter("CMPBrowser.GameMechanics", "CMPBrowser.damageType", 'damageTypes', 'select', CONFIG.DND5E.damageTypes);
        this.addItemFilter("CMPBrowser.GameMechanics", "CMPBrowser.UsesResources", 'usesRessources', 'bool');
        
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addItemFilter("CMPBrowser.ItemSubtype", "ITEM.TypeWeapon", 'system.weaponType', 'text', CONFIG.DND5E.weaponTypes);
            this.addItemFilter("CMPBrowser.ItemSubtype", "ITEM.TypeEquipment", 'system.armor.type', 'text', CONFIG.DND5E.equipmentTypes);
            this.addItemFilter("CMPBrowser.ItemSubtype", "ITEM.TypeConsumable", 'system.consumableType', 'text', CONFIG.DND5E.consumableTypes);
        }
        else {
            this.addItemFilter("CMPBrowser.ItemSubtype", "ITEM.TypeWeapon", 'data.weaponType', 'text', CONFIG.DND5E.weaponTypes);
            this.addItemFilter("CMPBrowser.ItemSubtype", "ITEM.TypeEquipment", 'data.armor.type', 'text', CONFIG.DND5E.equipmentTypes);
            this.addItemFilter("CMPBrowser.ItemSubtype", "ITEM.TypeConsumable", 'data.consumableType', 'text', CONFIG.DND5E.consumableTypes);
        }

        
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addItemFilter("CMPBrowser.MagicItems", "DND5E.Rarity", 'system.rarity', 'select', CONFIG.DND5E.itemRarity);
        }
        else {
            //0.7.2c: Fix rarity encoding (uses camelcase names)
            this.addItemFilter("CMPBrowser.MagicItems", "DND5E.Rarity", 'data.rarity', 'select', 
            {
                common: "DND5E.ItemRarityCommon",
                uncommon: "DND5E.ItemRarityUncommon",
                rare: "DND5E.ItemRarityRare",
                veryRare: "DND5E.ItemRarityVeryRare",
                legendary: "DND5E.ItemRarityLegendary",
            });
        }
    }

    async addFeatFilters() {
        
        // Feature Filters
        //Foundry v10+ Item#data is now Item#system
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addFeatFilter("CMPBrowser.general", "DND5E.Source", 'system.source.book', 'text');
        }
        else
        {
            this.addFeatFilter("CMPBrowser.general", "DND5E.Source", 'data.source.book', 'text');
        }
        this.addFeatFilter("CMPBrowser.general", "ITEM.TypeClass", 'classRequirement', 'select',
            {
                artificer: "CMPBrowser.artificer",
                barbarian: "CMPBrowser.barbarian",
                bard: "CMPBrowser.bard",
                cleric: "CMPBrowser.cleric",
                druid: "CMPBrowser.druid",
                fighter: "CMPBrowser.fighter",
                monk: "CMPBrowser.monk",
                paladin: "CMPBrowser.paladin",
                ranger: "CMPBrowser.ranger",
                rogue: "CMPBrowser.rogue",
                sorcerer: "CMPBrowser.sorcerer",
                warlock: "CMPBrowser.warlock",
                wizard: "CMPBrowser.wizard"
            }, true);

        let featureTypes = {
            class: "ITEM.TypeClass",
            feat: "ITEM.TypeFeat",
        };

        //subclasses don't exist lower then version 10
        if (CompendiumBrowser.isFoundryV10Plus) {
            featureTypes.subclass = "ITEM.TypeSubclass";
            featureTypes.background = "DND5E.Background";
        }
        if (CompendiumBrowser.isFoundryV11Plus) {
            featureTypes.race = "DND5E.Race";
        }

        this.addFeatFilter("CMPBrowser.general", "CMPBrowser.overall", 'type', 'select',
            featureTypes
            , false);

        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addFeatFilter("CMPBrowser.general", "DND5E.ItemFeatureType", 'system.type.value', 'select',
                Object.keys(dnd5e.config.featureTypes).reduce(function(acc, current) {
                    acc[current] = dnd5e.config.featureTypes[current].label;
                    return acc;
                }, {})
                , false);
        }

        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addFeatFilter("CMPBrowser.general", "CMPBrowser.subfeature", 'system.type.subtype', 'select',
                dnd5e.config.featureTypes.class.subtypes);
        }

        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addFeatFilter("CMPBrowser.GameMechanics", "DND5E.ItemActivationCost", 'system.activation.type', 'select', CONFIG.DND5E.abilityActivationTypes);
        }
        else {
            this.addFeatFilter("CMPBrowser.GameMechanics", "DND5E.ItemActivationCost", 'data.activation.type', 'select', CONFIG.DND5E.abilityActivationTypes);
        }
        this.addFeatFilter("CMPBrowser.GameMechanics", "CMPBrowser.damageType", 'damageTypes', 'select', CONFIG.DND5E.damageTypes);
        this.addFeatFilter("CMPBrowser.GameMechanics", "CMPBrowser.UsesResources", 'usesRessources', 'bool');


    }
    
    static CREATURE_TYPES = {
        aberration: "DND5E.CreatureAberration",
        beast: "DND5E.CreatureBeast",
        celestial: "DND5E.CreatureCelestial",
        construct: "DND5E.CreatureConstruct",
        dragon: "DND5E.CreatureDragon",
        elemental: "DND5E.CreatureElemental",
        fey: "DND5E.CreatureFey",
        fiend: "DND5E.CreatureFiend",
        giant: "DND5E.CreatureGiant",
        humanoid: "DND5E.CreatureHumanoid",
        monstrosity: "DND5E.CreatureMonstrosity",
        ooze: "DND5E.CreatureOoze",
        plant: "DND5E.CreaturePlant",
        undead: "DND5E.CreatureUndead"
    }

    async addNpcFilters() {
        // NPC Filters

        //Foundry v10+ Actor#data is now Actor#system
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addNpcFilter("CMPBrowser.general", "DND5E.Source", 'system.details.source', 'text');
            this.addNpcFilter("CMPBrowser.general", "DND5E.Size", 'system.traits.size', 'select', CONFIG.DND5E.actorSizes);

            if (CompendiumBrowser.isFoundryV10Minus){
                this.addNpcFilter("CMPBrowser.general", "CMPBrowser.hasSpells", 'hasSpells', 'bool');
            }

            this.addNpcFilter("CMPBrowser.general", "CMPBrowser.hasLegAct", 'system.resources.legact.max', 'bool');
            this.addNpcFilter("CMPBrowser.general", "CMPBrowser.hasLegRes", 'system.resources.legres.max', 'bool');
            this.addNpcFilter("CMPBrowser.general", "DND5E.ChallengeRating", 'system.details.cr', 'numberCompare');
        }
        else {
            this.addNpcFilter("CMPBrowser.general", "DND5E.Source", 'data.details.source', 'text');
            this.addNpcFilter("CMPBrowser.general", "DND5E.Size", 'data.traits.size', 'select', CONFIG.DND5E.actorSizes);
            this.addNpcFilter("CMPBrowser.general", "CMPBrowser.hasSpells", 'hasSpells', 'bool');
            this.addNpcFilter("CMPBrowser.general", "CMPBrowser.hasLegAct", 'data.resources.legact.max', 'bool');
            this.addNpcFilter("CMPBrowser.general", "CMPBrowser.hasLegRes", 'data.resources.legres.max', 'bool');
            this.addNpcFilter("CMPBrowser.general", "DND5E.ChallengeRating", 'data.details.cr', 'numberCompare');
        }

        let npcDetailsPath;
        //Foundry v10+ Actor#data is now Actor#system
        if (CompendiumBrowser.isFoundryV10Plus) {
            npcDetailsPath = "system.details.type.value";
        }
        //Foundry 0.8.x: Creature type (data.details.type) is now a structure, so we check data.details.types.value instead
        else if (CompendiumBrowser.isFoundryV8Plus) {
            npcDetailsPath = "data.details.type.value";
        }
        else {//0.7.x
            npcDetailsPath = "data.details.type";
        }

        this.addNpcFilter("CMPBrowser.general", "DND5E.CreatureType", npcDetailsPath, 'select', CompendiumBrowser.CREATURE_TYPES);
        //Foundry v10+ Actor#data is now Actor#system
        if (CompendiumBrowser.isFoundryV10Plus) {
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityStr", 'system.abilities.str.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityDex", 'system.abilities.dex.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityCon", 'system.abilities.con.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityInt", 'system.abilities.int.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityWis", 'system.abilities.wis.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityCha", 'system.abilities.cha.value', 'numberCompare');

            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.DamImm", 'system.traits.di.value', 'multiSelect', CONFIG.DND5E.damageTypes, true);
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.DamRes", 'system.traits.dr.value', 'multiSelect', CONFIG.DND5E.damageTypes, true);
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.DamVuln", 'system.traits.dv.value', 'multiSelect', CONFIG.DND5E.damageTypes, true);
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.ConImm", 'system.traits.ci.value', 'multiSelect', CONFIG.DND5E.conditionTypes, true);
        }
        else
        {
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityStr", 'data.abilities.str.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityDex", 'data.abilities.dex.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityCon", 'data.abilities.con.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityInt", 'data.abilities.int.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityWis", 'data.abilities.wis.value', 'numberCompare');
            this.addNpcFilter("DND5E.Abilities", "DND5E.AbilityCha", 'data.abilities.cha.value', 'numberCompare');
    
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.DamImm", 'data.traits.di.value', 'multiSelect', CONFIG.DND5E.damageTypes, true);
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.DamRes", 'data.traits.dr.value', 'multiSelect', CONFIG.DND5E.damageTypes, true);
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.DamVuln", 'data.traits.dv.value', 'multiSelect', CONFIG.DND5E.damageTypes, true);
            this.addNpcFilter("CMPBrowser.dmgInteraction", "DND5E.ConImm", 'data.traits.ci.value', 'multiSelect', CONFIG.DND5E.conditionTypes, true);
     
        }

        if (CompendiumBrowser.isFoundryV10Minus){
            this.addNpcFilter("CMPBrowser.dmgInteraction", "CMPBrowser.dmgDealt", 'damageDealt', 'multiSelect', CONFIG.DND5E.damageTypes, true);
        }
    }

    /**
     * Used to add custom filters to the Spell-Browser
     * @param {String} category - Title of the category
     * @param {String} label - Title of the filter
     * @param {String} path - path to the data that the filter uses. uses dotnotation. example: data.abilities.dex.value
     * @param {String} type - type of filter
     *                      possible filter:
     *                          text:           will give a textinput (or use a select if possibleValues has values) to compare with the data. will use objectData.indexOf(searchedText) to enable partial matching
     *                          bool:           will see if the data at the path exists and not false.
     *                          select:         exactly matches the data with the chosen selector from possibleValues
     *                          multiSelect:    enables selecting multiple values from possibleValues, any of witch has to match the objects data
     *                          numberCompare:  gives the option to compare numerical values, either with =, < or the > operator
     * @param {Boolean} possibleValues - predetermined values to choose from. needed for select and multiSelect, can be used in text filters
     * @param {Boolean} valIsArray - if the objects data is an object use this. the filter will check each property in the object (not recursive). if no match is found, the object will be hidden
     */
    addSpellFilter(category, label, path, type, possibleValues = null, valIsArray = false) {
        this.addFilter('spell', category, label, path, type, possibleValues, valIsArray);
    }

    /**
     * Used to add custom filters to the Spell-Browser
     * @param {String} category - Title of the category
     * @param {String} label - Title of the filter
     * @param {String} path - path to the data that the filter uses. uses dotnotation. example: data.abilities.dex.value
     * @param {String} type - type of filter
     *                      possible filter:
     *                          text:           will give a textinput (or use a select if possibleValues has values) to compare with the data. will use objectData.indexOf(searchedText) to enable partial matching
     *                          bool:           will see if the data at the path exists and not false.
     *                          select:         exactly matches the data with the chosen selector from possibleValues
     *                          multiSelect:    enables selecting multiple values from possibleValues, any of witch has to match the objects data
     *                          numberCompare:  gives the option to compare numerical values, either with =, < or the > operator
     * @param {Boolean} possibleValues - predetermined values to choose from. needed for select and multiSelect, can be used in text filters
     * @param {Boolean} valIsArray - if the objects data is an object use this. the filter will check each property in the object (not recursive). if no match is found, the object will be hidden
     */
    addNpcFilter(category, label, path, type, possibleValues = null, valIsArray = false) {
        this.addFilter('npc', category, label, path, type, possibleValues, valIsArray);
    }

    addFeatFilter(category, label, path, type, possibleValues = null, valIsArray = false) {
        this.addFilter('feat', category, label, path, type, possibleValues, valIsArray);
    }

    addItemFilter(category, label, path, type, possibleValues = null, valIsArray = false) {
        this.addFilter('item', category, label, path, type, possibleValues, valIsArray);
    }

    async renderWith(tab="spell", filters=[]){

        //if there isn't a tab error out
        if(!this[`${tab}Filters`]){
            ui.notifications.warn(`no tab by name ${tab}`);
            return
        }

        this.resetFilters();

        this.refreshList = tab;

        let html = await this.render();

        let activateFilters = filters.reduce((acc, input) => {
            let filter = this.findFilter(tab, input.section, input.label);

            if (filter){
                if (input.value){
                    filter.value = input.value;
                }
                else if(input.values){
                    filter.values = input.values;
                }
                else{
                    ui.notifications.warn(`no value(s) in filter:${tab} ${input.section}, ${input.label}`);
                }

                acc[stripSpecialCharacters(filter.path)] = filter;
            }
            else{
                ui.notifications.warn(`filter not found: tab:${tab} ${input.section}, ${input.label}.`);
            }

            return acc;
        },
        {})

        this[`${tab}Filters`].activeFilters = activateFilters;

        //wait for after the afterRender function to change tabs
        //this avoids some errors when initially opening the window
        CompendiumBrowser.postRender = async ()=>{

            CompendiumBrowser.postRender = ()=>{};

            await html.activateTab(tab);

            for (let input of filters){
                let filter = this.findFilter(tab, input.section, input.label);

                if (!filter){
                    continue;
                }

                const typeMap = {
                    select:"select",
                    bool: "select",
                    text: "input",
                }

                if (filter.type in typeMap){
                    let component = html.element.find(`div.tab.active #${input.section}-${input.label} ${typeMap[filter.type]}`)

                    component[0].value = input.value;
                }
                else if (filter.type == "multiSelect"){
                    let components = html.element.find(`div.tab.active #${input.section}-${input.label}`)

                    for (let v of input.values){
                        let c = components.find(`input[data-value=${v}]`)
                        c.prop( "checked", true );
                    }
                }
                else{
                    ui.notifications.warn(`Unknown filter type?`);
                    console.log(filter)
                }

            }

        };

        this.render(true);

        return this
    }

    findFilter(type, category, label){
        let target = `${type}Filters`;
        let catId = stripSpecialCharacters(category);
        
        if (!this[target].registeredFilterCategorys[catId]){
            return;
        }
        
        let filter = this[target].registeredFilterCategorys[catId].filters.
            find(x => x.labelId == label)

        if (!filter){
            return;
        }

        return {
            path: filter.path,
            type: filter.type,
            valIsArray: filter.valIsArray,
        }
    }

    getSearchText(tab){
        const target = `${tab}Filters`

        //map active filters to their labels
        let output = Object.values(this[target].activeFilters).map(filter => {
            //find Filters from paths
            let out = this.findFilterR(target, filter)

            if(filter.value){
                out.value = filter.value;
            }
            else if(filter.values){
                out.values = filter.values;
            }

            return out;
        })

        const strOut = `game.compendiumBrowser.renderWith("${tab}", ${JSON.stringify(output)})`

        return strOut;
    }

    findFilterR(target, filterTarget){
        for (let cat of Object.keys(this[target].registeredFilterCategorys)){
            for (let filter of this[target].registeredFilterCategorys[cat].filters){
                if (filterTarget.path == filter.path){
                    return {section:`${cat}`, label:`${filter.labelId}`}
                }
            }
        }

        ui.notifications.warn("Could not find the filter!!")
        console.warn(filterTarget)
        return;
    }

    static async addTidySheetButton(cb, html, actor){

        await html.find('.spell-browser-btn').remove();
        const extrabuttons = game.settings.get(CMPBrowser.MODULE_NAME, "extrabuttons") ?? true;
        if (!extrabuttons){
            return;
        }

        let tabBar = html.find("div.tab.spellbook .spellcasting-ability")
        const tooltip = game.i18n.localize("CMPBrowser.ToolTip.Spells") ?? "CMPBrowser.ToolTip.Spells"

        const cbButton = $(`<div style="max-width:40px;min-width:32px;"><a title="${tooltip}" class="compendium-browser spell-browser-btn"><i class="fa-duotone fa-book"></i></a></div>`);

        tabBar.append(cbButton)

        CompendiumBrowser.addSpellsButton(cbButton, actor.actor)
    }

    static async addDefaultSheetButton(cb, html, actor){

        await html.find('.spell-browser-btn').remove();
        const extrabuttons = game.settings.get(CMPBrowser.MODULE_NAME, "extrabuttons") ?? true;
        if (!extrabuttons){
            return;
        }

        let tabBar = html.find("div.spellbook-filters")
        const tooltip = game.i18n.localize("CMPBrowser.ToolTip.Spells") ?? "CMPBrowser.ToolTip.Spells"

        const cbButton = $(`<div style="max-width:40px;min-width:32px;"><a title="${tooltip}" class="compendium-browser spell-browser-btn"><i class="fa-duotone fa-book"></i></a></div>`);
        console.log(tabBar)

        tabBar.append(cbButton)

        CompendiumBrowser.addSpellsButton(cbButton, actor.actor)
    }

    static addSpellsButton(cbButton, character){

        cbButton.click(async ev => {
                ev.preventDefault();

                let target = [];

                target = target.concat(CompendiumBrowser.findCasterClass(character));
                target = target.concat(CompendiumBrowser.findMaxCasterLevel(character));

                game.compendiumBrowser.renderWith("spell", target);
            });

    }

    static async addASISheetButton(cb, html){

        await html.find('.feat-browser-btn').remove();

        const extrabuttons = game.settings.get(CMPBrowser.MODULE_NAME, "extrabuttons") ?? true;
        if (!extrabuttons){
            return;
        }
        const tooltip = game.i18n.localize("CMPBrowser.ToolTip.Feats") ?? "CMPBrowser.ToolTip.Feats"
        let dropArea = html.find("div.drop-area")
        const cbButton = $(`<div style="max-width:40px;min-width:32px;"><a title="${tooltip}" class="compendium-browser feat-browser-btn"><i class="fa-duotone fa-book"></i></a></div>`);

        dropArea.append(cbButton)

        cbButton.click(async ev => {
            ev.preventDefault();

            game.compendiumBrowser.renderWith("feat", [{"section":"CMPBrowsergeneral","label":"DND5EItemFeatureType", value: "feat" }]);
        });
    }

    //find the first caster class of the character
    static findCasterClass(character){
        const options = ["artificer", "bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"]

        for (let cls of Object.keys(character.classes)){
            if (options.includes(cls)){
                return [{"section":"CMPBrowsergeneral","label":"ITEMTypeClass","value":cls}];
            }
        }

        return [];
    }

    static findMaxCasterLevel(character){

        //find max spell level
        let maxLevel = Object.keys(character.system.spells).reduce((acc, spell)=>{
            //special case for pact magic
            if (spell == "pact"){
                return Math.max(character.system.spells[spell].level, acc)
            }
            else{
                let spellObject = character.system.spells[spell];
                if ((spellObject.override ?? spellObject.max) > 0){
                    let match = spell.match(/spell(?<lvl>\d+)/);
                    return Math.max(parseInt(match.groups.lvl), acc)
                }
            }

            return acc
        }, 0)

        if (maxLevel > 0){
            return [{"section":"CMPBrowsergeneral","label":"DND5ELevel", values: [...Array(maxLevel + 1).keys()]}];
        }

        return [];
    }
}

Hooks.on('ready', async () => {

    if (game.compendiumBrowser === undefined) {
        game.compendiumBrowser = new CompendiumBrowser();
//0.4.0 Defer loading content until we actually use the Compendium Browser
        //A compromise approach would be better (periodic loading) except would still create the memory use problem
        await game.compendiumBrowser.initialize();
    }

    game.compendiumBrowser.addSpellFilters();
    game.compendiumBrowser.addFeatFilters();
    game.compendiumBrowser.addItemFilters();
    game.compendiumBrowser.addNpcFilters();

});

function stripSpecialCharacters(str){
    return str.replace(/\W/g, '');
}

function stripDotCharacters(str){
    return str.replace(/\./g, '');
}

function set(obj, path, value) {
    var schema = obj;  // a moving reference to internal objects within obj
    var pList = path.split('.');
    var len = pList.length;
    for(var i = 0; i < len-1; i++) {
        var elem = pList[i];
        if( !schema[elem] ) schema[elem] = {}
        schema = schema[elem];
    }

    schema[pList[len-1]] = value;
}

function getPropByString(obj, propString) {
  if (!propString)
    return obj;

  var prop, props = propString.split('.');

  for (var i = 0, iLen = props.length - 1; i < iLen; i++) {
    prop = props[i];

    var candidate = obj[prop];
    if (candidate !== undefined) {
      obj = candidate;
    } else {
      break;
    }
  }
  return obj[props[i]];
}

Hooks.on("renderActorSheet5eCharacter", CompendiumBrowser.addDefaultSheetButton);
Hooks.on("renderTidy5eSheet", CompendiumBrowser.addTidySheetButton);
Hooks.on("renderAbilityScoreImprovementFlow", CompendiumBrowser.addASISheetButton);

Hooks.on("renderCompendiumBrowser", CompendiumBrowser.afterRender);
