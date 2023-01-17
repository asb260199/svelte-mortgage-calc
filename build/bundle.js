var app = (function () {
    'use strict';

    function noop() { }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }
    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        if (node.parentNode) {
            node.parentNode.removeChild(node);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function to_number(value) {
        return value === '' ? null : +value;
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.wholeText !== data)
            text.data = data;
    }
    function set_input_value(input, value) {
        input.value = value == null ? '' : value;
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    // flush() calls callbacks in this order:
    // 1. All beforeUpdate callbacks, in order: parents before children
    // 2. All bind:this callbacks, in reverse order: children before parents.
    // 3. All afterUpdate callbacks, in order: parents before children. EXCEPT
    //    for afterUpdates called during the initial onMount, which are called in
    //    reverse order: children before parents.
    // Since callbacks might update component values, which could trigger another
    // call to flush(), the following steps guard against this:
    // 1. During beforeUpdate, any updated components will be added to the
    //    dirty_components array and will cause a reentrant call to flush(). Because
    //    the flush index is kept outside the function, the reentrant call will pick
    //    up where the earlier call left off and go through all dirty components. The
    //    current_component value is saved and restored so that the reentrant call will
    //    not interfere with the "parent" flush() call.
    // 2. bind:this callbacks cannot trigger new flush() calls.
    // 3. During afterUpdate, any updated components will NOT have their afterUpdate
    //    callback called a second time; the seen_callbacks set, outside the flush()
    //    function, guarantees this behavior.
    const seen_callbacks = new Set();
    let flushidx = 0; // Do *not* move this inside the flush() function
    function flush() {
        // Do not reenter flush while dirty components are updated, as this can
        // result in an infinite loop. Instead, let the inner flush handle it.
        // Reentrancy is ok afterwards for bindings etc.
        if (flushidx !== 0) {
            return;
        }
        const saved_component = current_component;
        do {
            // first, call beforeUpdate functions
            // and update components
            try {
                while (flushidx < dirty_components.length) {
                    const component = dirty_components[flushidx];
                    flushidx++;
                    set_current_component(component);
                    update(component.$$);
                }
            }
            catch (e) {
                // reset dirty state to not end up in a deadlocked state and then rethrow
                dirty_components.length = 0;
                flushidx = 0;
                throw e;
            }
            set_current_component(null);
            dirty_components.length = 0;
            flushidx = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        seen_callbacks.clear();
        set_current_component(saved_component);
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    const outroing = new Set();
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = component.$$.on_mount.map(run).filter(is_function);
                // if the component was destroyed immediately
                // it will update the `$$.on_destroy` reference to `null`.
                // the destructured on_destroy may still reference to the old array
                if (component.$$.on_destroy) {
                    component.$$.on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, append_styles, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: [],
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(options.context || (parent_component ? parent_component.$$.context : [])),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false,
            root: options.target || parent_component.$$.root
        };
        append_styles && append_styles($$.root);
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            flush();
        }
        set_current_component(parent_component);
    }
    /**
     * Base class for Svelte components. Used when dev=false.
     */
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            if (!is_function(callback)) {
                return noop;
            }
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set($$props) {
            if (this.$$set && !is_empty($$props)) {
                this.$$.skip_bound = true;
                this.$$set($$props);
                this.$$.skip_bound = false;
            }
        }
    }

    /* src\App.svelte generated by Svelte v3.55.1 */

    function create_fragment(ctx) {
    	let main;
    	let div0;
    	let t1;
    	let div1;
    	let label0;
    	let t3;
    	let input0;
    	let t4;
    	let div4;
    	let div2;
    	let label1;
    	let t6;
    	let input1;
    	let t7;
    	let div3;
    	let t8;
    	let t9;
    	let t10;
    	let div7;
    	let div5;
    	let label2;
    	let t12;
    	let input2;
    	let t13;
    	let div6;
    	let t14_value = /*interestRate*/ ctx[5].toFixed(2) + "";
    	let t14;
    	let t15;
    	let t16;
    	let div8;
    	let t17;
    	let t18_value = /*formatter*/ ctx[7].format(/*monthlyPayment*/ ctx[4]) + "";
    	let t18;
    	let t19;
    	let div9;
    	let t20;
    	let t21_value = /*formatter*/ ctx[7].format(/*totalPaid*/ ctx[3]) + "";
    	let t21;
    	let t22;
    	let div10;
    	let t23;
    	let t24_value = /*formatter*/ ctx[7].format(/*interestPaid*/ ctx[6]) + "";
    	let t24;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			main = element("main");
    			div0 = element("div");
    			div0.innerHTML = `<h1>Mortgage Calculator</h1>`;
    			t1 = space();
    			div1 = element("div");
    			label0 = element("label");
    			label0.textContent = "Loan Amount";
    			t3 = space();
    			input0 = element("input");
    			t4 = space();
    			div4 = element("div");
    			div2 = element("div");
    			label1 = element("label");
    			label1.textContent = "Years";
    			t6 = space();
    			input1 = element("input");
    			t7 = space();
    			div3 = element("div");
    			t8 = text(/*years*/ ctx[1]);
    			t9 = text(" years");
    			t10 = space();
    			div7 = element("div");
    			div5 = element("div");
    			label2 = element("label");
    			label2.textContent = "Interest Rate";
    			t12 = space();
    			input2 = element("input");
    			t13 = space();
    			div6 = element("div");
    			t14 = text(t14_value);
    			t15 = text("%");
    			t16 = space();
    			div8 = element("div");
    			t17 = text("Monthly Payments ");
    			t18 = text(t18_value);
    			t19 = space();
    			div9 = element("div");
    			t20 = text("Total Paid ");
    			t21 = text(t21_value);
    			t22 = space();
    			div10 = element("div");
    			t23 = text("Interest Paid ");
    			t24 = text(t24_value);
    			attr(div0, "class", "row");
    			attr(input0, "min", "1");
    			attr(input0, "placeholder", "Please Enter loan amount");
    			attr(input0, "type", "number");
    			attr(input0, "class", "u-full-width");
    			attr(div1, "class", "row");
    			attr(input1, "type", "range");
    			attr(input1, "min", "1");
    			attr(input1, "max", "50");
    			attr(input1, "class", "u-full-width");
    			attr(div2, "class", "columns six");
    			attr(div3, "class", "columns six outputs svelte-7w4h10");
    			attr(div4, "class", "row");
    			attr(input2, "type", "range");
    			attr(input2, "min", "1");
    			attr(input2, "max", "2000");
    			attr(input2, "class", "u-full-width");
    			attr(div5, "class", "columns six");
    			attr(div6, "class", "columns six outputs svelte-7w4h10");
    			attr(div7, "class", "row");
    			attr(div8, "class", "row outputs svelte-7w4h10");
    			attr(div9, "class", "row outputs svelte-7w4h10");
    			attr(div10, "class", "row outputs svelte-7w4h10");
    			attr(main, "class", "container");
    		},
    		m(target, anchor) {
    			insert(target, main, anchor);
    			append(main, div0);
    			append(main, t1);
    			append(main, div1);
    			append(div1, label0);
    			append(div1, t3);
    			append(div1, input0);
    			set_input_value(input0, /*loanAmount*/ ctx[0]);
    			append(main, t4);
    			append(main, div4);
    			append(div4, div2);
    			append(div2, label1);
    			append(div2, t6);
    			append(div2, input1);
    			set_input_value(input1, /*years*/ ctx[1]);
    			append(div4, t7);
    			append(div4, div3);
    			append(div3, t8);
    			append(div3, t9);
    			append(main, t10);
    			append(main, div7);
    			append(div7, div5);
    			append(div5, label2);
    			append(div5, t12);
    			append(div5, input2);
    			set_input_value(input2, /*interestRateInput*/ ctx[2]);
    			append(div7, t13);
    			append(div7, div6);
    			append(div6, t14);
    			append(div6, t15);
    			append(main, t16);
    			append(main, div8);
    			append(div8, t17);
    			append(div8, t18);
    			append(main, t19);
    			append(main, div9);
    			append(div9, t20);
    			append(div9, t21);
    			append(main, t22);
    			append(main, div10);
    			append(div10, t23);
    			append(div10, t24);

    			if (!mounted) {
    				dispose = [
    					listen(input0, "input", /*input0_input_handler*/ ctx[10]),
    					listen(input1, "change", /*input1_change_input_handler*/ ctx[11]),
    					listen(input1, "input", /*input1_change_input_handler*/ ctx[11]),
    					listen(input2, "change", /*input2_change_input_handler*/ ctx[12]),
    					listen(input2, "input", /*input2_change_input_handler*/ ctx[12])
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*loanAmount*/ 1 && to_number(input0.value) !== /*loanAmount*/ ctx[0]) {
    				set_input_value(input0, /*loanAmount*/ ctx[0]);
    			}

    			if (dirty & /*years*/ 2) {
    				set_input_value(input1, /*years*/ ctx[1]);
    			}

    			if (dirty & /*years*/ 2) set_data(t8, /*years*/ ctx[1]);

    			if (dirty & /*interestRateInput*/ 4) {
    				set_input_value(input2, /*interestRateInput*/ ctx[2]);
    			}

    			if (dirty & /*interestRate*/ 32 && t14_value !== (t14_value = /*interestRate*/ ctx[5].toFixed(2) + "")) set_data(t14, t14_value);
    			if (dirty & /*monthlyPayment*/ 16 && t18_value !== (t18_value = /*formatter*/ ctx[7].format(/*monthlyPayment*/ ctx[4]) + "")) set_data(t18, t18_value);
    			if (dirty & /*totalPaid*/ 8 && t21_value !== (t21_value = /*formatter*/ ctx[7].format(/*totalPaid*/ ctx[3]) + "")) set_data(t21, t21_value);
    			if (dirty & /*interestPaid*/ 64 && t24_value !== (t24_value = /*formatter*/ ctx[7].format(/*interestPaid*/ ctx[6]) + "")) set_data(t24, t24_value);
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(main);
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let interestRate;
    	let totalPayments;
    	let monthlyInterestRate;
    	let monthlyPayment;
    	let totalPaid;
    	let interestPaid;
    	var formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    	let loanAmount = 200000;
    	let years = 15;
    	let interestRateInput = 200;

    	function input0_input_handler() {
    		loanAmount = to_number(this.value);
    		$$invalidate(0, loanAmount);
    	}

    	function input1_change_input_handler() {
    		years = to_number(this.value);
    		$$invalidate(1, years);
    	}

    	function input2_change_input_handler() {
    		interestRateInput = to_number(this.value);
    		$$invalidate(2, interestRateInput);
    	}

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*interestRateInput*/ 4) {
    			$$invalidate(5, interestRate = interestRateInput / 100);
    		}

    		if ($$self.$$.dirty & /*years*/ 2) {
    			$$invalidate(8, totalPayments = years * 12);
    		}

    		if ($$self.$$.dirty & /*interestRate*/ 32) {
    			$$invalidate(9, monthlyInterestRate = interestRate / 100 / 12);
    		}

    		if ($$self.$$.dirty & /*loanAmount, monthlyInterestRate, totalPayments*/ 769) {
    			$$invalidate(4, monthlyPayment = loanAmount * Math.pow(1 + monthlyInterestRate, totalPayments) * monthlyInterestRate / (Math.pow(1 + monthlyInterestRate, totalPayments) - 1));
    		}

    		if ($$self.$$.dirty & /*monthlyPayment, totalPayments*/ 272) {
    			$$invalidate(3, totalPaid = monthlyPayment * totalPayments);
    		}

    		if ($$self.$$.dirty & /*totalPaid, loanAmount*/ 9) {
    			$$invalidate(6, interestPaid = totalPaid - loanAmount);
    		}
    	};

    	return [
    		loanAmount,
    		years,
    		interestRateInput,
    		totalPaid,
    		monthlyPayment,
    		interestRate,
    		interestPaid,
    		formatter,
    		totalPayments,
    		monthlyInterestRate,
    		input0_input_handler,
    		input1_change_input_handler,
    		input2_change_input_handler
    	];
    }

    class App extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance, create_fragment, safe_not_equal, {});
    	}
    }

    const app = new App({
    	target: document.body
    });

    return app;

})();
//# sourceMappingURL=bundle.js.map
