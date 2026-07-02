# 从 IRL 到 RLHF，再到 RLVR：LLM 后训练到底在学什么奖励？

> The reward is not the point; the point is where the reward points.

如果只看算法名字，今天的大模型后训练很容易被讲成一串缩写：RLHF、RLAIF、PPO、GRPO、DPO、RLVR、PRM。它们看起来像是同一件事的不同版本：都在用某种 RL 方法让模型变好。

但这个理解其实不够准确。更关键的问题不是“用了哪个优化器”，而是：

> reward 从哪里来？

要回答这个问题，需要先把 RL 放回 LLM 的整体训练链路里看。一个聊天模型不是一开始就通过 RL 训练出来的；通常是先通过大规模预训练获得语言、知识和泛化能力，再通过后训练把它变成更愿意听指令、更安全、更擅长推理的 assistant。RL 主要出现在这个后训练阶段。

如果 reward 已经可以被明确写出来，RL 要解决的是如何在这个 reward 下优化 policy。如果 reward 写不出来，只能从人类行为、偏好或专家示范中反推，那么问题就带有 Inverse Reinforcement Learning（IRL）的味道。这个视角能把传统 RL、IRL、RLHF、DPO，以及 reasoning / thinking 模型中的 RLVR 放到同一张图里。

这是一条很值得抓住的线索：LLM RL 并不是凭空出现的新范式，它延续了经典 RL 里“reward 如何获得”的老问题，只是这个问题在语言模型里变得更抽象，也更重要。

## 1. 先看 LLM 的整体训练链路

现代 LLM 的训练可以粗略分成三层：

```text
Pretraining
    ↓
Instruction tuning / SFT
    ↓
Post-training for alignment and reasoning
    ├─ Preference alignment: RLHF / RLAIF / DPO
    └─ Reasoning training: RLVR / rule-based RL / verifier-based RL
```

第一层是 pretraining。模型在海量文本、代码和多模态数据上做 next-token prediction，学会语言模式、世界知识、代码结构和基本推理能力。这个阶段训练出来的是 base model，它会续写文本，但不一定稳定地遵循用户意图。

第二层是 instruction tuning 或 supervised fine-tuning（SFT）。模型用人工写好的指令-回答数据、合成数据或高质量对话数据继续训练，学会“用户问问题，我给出回答”的基本交互格式。很多开源 chat model 到这一步已经可以使用。

第三层才是本文关注的 post-training。后训练不是为了让模型重新学习所有知识，而是为了调整行为分布：什么回答更有帮助，什么回答更安全，遇到数学题要不要多想几步，代码能不能通过测试，工具调用是否完成任务。RL 在 LLM 里的作用主要就出现在这里：它把“反馈信号”转成对 policy 的更新。

所以，RL 不是整个 LLM 训练流程的起点，而是后训练工具箱里的一类方法。理解它之前，我们先从最基础的 RL 定义开始。

## 2. RL 是什么：从反馈中学习 policy

Reinforcement Learning（强化学习）研究的是这样一类问题：一个 agent 在环境中行动，环境给它反馈，agent 根据反馈调整自己的行为策略，让未来获得的累计 reward 更高。

最小化地说，RL 包含四个对象：

```text
state:  当前处境
action: agent 可以采取的动作
reward: 环境给出的反馈
policy: agent 选择动作的策略
```

更正式的 MDP（Markov Decision Process）只是把这些对象写成数学形式；理解本文不需要一上来进入完整 MDP。对 LLM 来说，可以先用一个近似类比：

- state 约等于 prompt 或 conversation context，也就是模型当前看到的上下文。
- action 约等于 completion 或 token sequence，也就是模型接下来生成的内容。
- reward 约等于人类偏好分数、Reward Model 分数，或者测试是否通过。
- policy 约等于当前语言模型 $\pi_\theta$，也就是“在给定上下文下，模型会生成什么”的概率分布，其中 $\theta$ 表示模型参数。

于是标准 RL 的设定是：

$$
\pi^\star = \arg\max_\pi \; \mathbb{E}_{\pi}\left[\sum_{t=0}^{T} \gamma^t R(s_t,a_t)\right]
$$

也就是说，RL 要找到一个策略 $\pi^\star$，让未来累计 reward 的期望尽可能高。这里的 $s_t$ 是时刻 $t$ 的 state，$a_t$ 是时刻 $t$ 的 action，$R(s_t,a_t)$ 表示在状态 $s_t$ 下采取动作 $a_t$ 会得到多少奖励；$\pi(a \mid s)$ 表示 agent 在状态 $s$ 下选择动作 $a$ 的概率，其中 $\pi$ 是强化学习里常用来表示 policy 的符号；$\mathbb{E}_{\pi}$ 表示期望来自当前策略 $\pi$ 采样出的行为；$\gamma$ 是折扣因子，用来降低较远未来 reward 的权重；$T$ 是时间范围或任务结束步数。

在这个设定下，奖励函数已经给定，算法的任务是找到一个策略，让长期累计奖励尽可能高。

例如机器人走路，可以粗略地规定：前进一步给 $+1$，摔倒给 $-100$，能耗过高时扣除一个与能耗相关的惩罚项，比如 $-\lambda \cdot \text{energy}$，其中 $\lambda$ 控制能耗惩罚的强度。

代码生成任务里，也可以把 reward 直接绑定到测试：

如果单元测试通过，reward 是 $1$；如果失败，reward 是 $0$。

在这些问题里，RL 的核心难点是优化：怎么采样，怎么估计梯度，怎么降低方差，怎么避免 policy 更新过猛。PPO、REINFORCE、GRPO 这类方法都可以被放在这个层面理解。它们关心的是：在已有 reward 下，怎样更稳定、更高效地更新 policy。

但很多真实任务最大的困难并不在这里，而在 reward 本身。

什么叫“回答有帮助”？什么叫“诚实”？什么叫“安全”？什么叫“推理过程更好”？这些目标通常无法像“测试是否通过”那样写成一个清晰的函数。于是问题反过来了：我们不是先有 reward 再优化 policy，而是要先问，reward 到底是什么。

## 3. IRL：当 reward 写不出来时，从行为中反推

Inverse Reinforcement Learning 解决的正是这个反方向问题。

传统 RL 是：

```text
Reward → Policy
```

IRL 则是：

```text
Expert demonstrations → Reward
```

它的基本假设是：专家的行为不是随机的，而是在某个隐含奖励函数下近似最优。我们观察专家怎么做，然后尝试推断：如果专家这样行动，那么他背后可能在优化什么 reward？

比如自动驾驶里，人类司机会避开行人、保持车道、平稳刹车、尽量快速到达目的地。我们未必能手工写出一个完整 reward，但可以从大量驾驶示范里反推：哪些轨迹更像“好驾驶”，哪些轨迹明显不合理。

经典 maximum entropy IRL 可以从 maximum likelihood 的角度理解：给定专家轨迹，希望这些轨迹在当前 reward 下看起来更可能、更“optimal”。下面这个公式不是理解全文必须掌握的细节，它只是说明 IRL 如何把 reward 和行为概率联系起来：在 maximum entropy / control-as-inference 的框架下，一个状态-动作对被视为 optimal 的概率与 reward 的指数相关。

$$
p(O_t \mid s_t, a_t) \propto \exp\left(r_\psi(s_t, a_t)\right)
$$

这个式子表示：在状态 $s_t$ 下采取动作 $a_t$ 的 reward 越高，这个行为越容易被解释为“optimal”。其中，$O_t$ 表示时刻 $t$ 的 optimality 事件，$s_t$ 是状态，$a_t$ 是动作，$r_\psi$ 是带参数 $\psi$ 的 reward function，$\propto$ 表示“正比于”，$\exp(\cdot)$ 表示指数函数。

直觉上，这表示 reward 越高的行为，越可能被解释为“专家会做的行为”。学习 reward 时，一方面要提高专家轨迹的 reward，另一方面也要和当前 policy 采样出的轨迹做对比。于是 IRL 看起来像一个交替过程：

```text
用当前 reward 优化 policy
        ↓
采样 policy 的轨迹
        ↓
让专家轨迹比 policy 轨迹更像 optimal
        ↓
更新 reward
```

这个结构很重要，因为它已经暗示了后来的 RLHF：先学习一个 reward，再用 RL 优化模型。

## 4. RLHF：Reward Model 是 IRL 风格的 reward learning

来到 LLM，状态可以近似理解为 prompt，动作可以理解为 completion。模型 $\pi_\theta$ 接收一个 prompt $s$，生成一个回答 $a$，然后得到某个 reward $r(s,a)$。这里的 $r(s,a)$ 表示“对于 prompt $s$ 和回答 $a$，系统给出的奖励分数”。为了和前面传统 RL 里的环境 reward $R(s,a)$ 区分，后面会用小写 $r$ 表示 LLM 后训练里的 reward score。

问题是，对于聊天助手来说，$r(s,a)$ 通常无法手工定义。

用户问“帮我写一封拒绝合作的邮件”，什么回答最好？正式一点还是温和一点？短一点还是解释充分一点？这些都不是单一 ground truth 能决定的。于是 RLHF 采用了人类偏好数据：

```text
Prompt
  ├─ Answer A
  └─ Answer B
Human: A is better than B
```

然后用这些偏好训练 Reward Model。这个 Reward Model 可以写成 $r_\psi(s,a)$，其中 $s$ 是 prompt，$a$ 是回答，$\psi$ 是 Reward Model 的参数。也就是说，带参数的 $r_\psi$ 表示需要从偏好数据中学习出来的 reward function。训练好 Reward Model 之后，再用 PPO、REINFORCE 或 GRPO 这类 RL 算法去更新语言模型策略 $\pi_\theta$。

偏好学习里常用 Bradley-Terry model 来表达比较数据。这里沿用 IRL 里的记号 $\tau$：在传统 RL 里它通常表示一条轨迹，在 LLM 场景里，一个 completion 也可以被看成 token 序列形成的一条短轨迹。若人类偏好轨迹或回答 $\tau_i$ 胜过 $\tau_j$，则：

$$
p(\tau_i \succ \tau_j) = \sigma\left(r_\psi(\tau_i) - r_\psi(\tau_j)\right)
$$

这个式子表示：人类选择 $\tau_i$ 而不是 $\tau_j$ 的概率，取决于二者的 reward difference。其中，$\tau_i$ 和 $\tau_j$ 表示两个候选回答或轨迹，$\succ$ 表示“偏好前者胜过后者”，$r_\psi(\tau)$ 是 Reward Model 给轨迹 $\tau$ 的分数，$\sigma(\cdot)$ 是 sigmoid 函数，用来把 reward difference 转成 $0$ 到 $1$ 之间的概率。训练 Reward Model 就是在最大化人类偏好数据的似然，让被人类选中的回答获得更高 reward。

这一步就是 RLHF 和 IRL 最接近的地方。程序员没有直接写出“有帮助、诚实、安全”的 reward，而是通过人类比较数据反推出一个 reward function。它不一定是经典 IRL 的完整形式，但在问题结构上非常相似：

```text
Human behavior / preference
        ↓
Learn reward
        ↓
Optimize policy
```

因此，更精确的说法不是“所有 LLM Alignment 本质上都是 IRL”，而是：

> RLHF / preference alignment 可以被看作一种 IRL 风格的 reward learning：它从人类偏好中学习隐含 reward，再用 RL 优化语言模型策略。

这个说法保留了 IRL 的核心洞察，也避免把所有 LLM 后训练都粗暴归为 IRL。

## 5. PPO、GRPO 解决的是优化，不是 reward 来源

RLHF 里常常提到 PPO，所以很多人会把 RLHF 理解成“用 PPO 训练大模型”。但从 reward-source 的视角看，PPO 只是第二阶段的优化方法。

一旦已经有了 reward $r(s,a)$，可以用 policy gradient 来优化：

$$
\nabla_\theta J(\theta)
=
\mathbb{E}_{s,a \sim \pi_\theta}
\left[
\nabla_\theta \log \pi_\theta(a \mid s)\, r(s,a)
\right]
$$

这个式子表示：如果某个回答 $a$ 在 prompt $s$ 下得到更高 reward，那么就提高当前 policy $\pi_\theta$ 生成它的概率。其中，$J(\theta)$ 是希望最大化的期望 reward 目标，$\theta$ 是语言模型参数，$\nabla_\theta$ 表示对 $\theta$ 求梯度，$\mathbb{E}$ 表示对当前模型采样结果取期望，$\pi_\theta(a \mid s)$ 是模型在 prompt $s$ 下生成回答 $a$ 的概率，$r(s,a)$ 是该 prompt-answer pair 的 reward。

PPO 可以通过 importance weighting 和 clipping 让更新更稳定。GRPO 则可以理解为一种更适合 LLM 场景的 baseline 设计：对同一个 prompt 采样多个 completion，用同组 completion 的平均 reward 作为 per-prompt baseline，让模型关心“这个回答比同题其他回答好多少”。

因此，PPO、REINFORCE、GRPO 的差别主要在 policy optimization；它们不回答 reward 从哪里来。

这也是为什么很多 LLM 后训练讨论里，真正决定上限的往往不是“换一个 optimizer”，而是 reward 是否可靠。Reward Model 如果学偏了，policy optimization 只会更高效地放大这个偏差。

这类 learned reward 还有一个重要风险：Reward Model 并不完美，如果无限制地优化，模型可能学会 reward hacking，得到高分却输出无意义文本。常见缓解方式是加入 reference model regularization，也就是用 KL penalty 限制模型不要偏离参考模型太远。更准确地说，训练时优化的不是单纯的 Reward Model 分数，而是带 KL 约束的目标：

$$
J_{\mathrm{reg}}(\theta)
=
\mathbb{E}_{a \sim \pi_\theta(\cdot \mid s)}
\left[
r_\psi(s,a)
\right]
-
\beta D_{\mathrm{KL}}
\left(
\pi_\theta(\cdot \mid s)
\;\|\;
\pi_{\mathrm{ref}}(\cdot \mid s)
\right)
$$

这个式子表示：regularized objective $J_{\mathrm{reg}}(\theta)$ 等于当前模型生成回答的期望 Reward Model 分数，减去一个 KL 惩罚项。其中，$r_\psi(s,a)$ 是 learned reward，$\beta$ 控制惩罚强度，$D_{\mathrm{KL}}(\cdot\|\cdot)$ 衡量两个分布的差异，$\pi_\theta$ 是当前正在训练的模型，$\pi_{\mathrm{ref}}$ 是参考模型，通常是 SFT model 或 RL 开始前的模型。

这不是在重新定义人类价值观，而是在承认 learned reward 有缺陷，因此优化时必须加约束。

## 6. DPO：没有显式 Reward Model，也仍然有隐含 reward

DPO 看起来像是对 RLHF 的简化：不单独训练 Reward Model，也不显式跑 PPO，而是直接用偏好数据优化 policy。

但这并不意味着 reward 消失了。偏好数据 $A \succ B$ 本身仍然表达了一个 reward difference：

$$
r(s,A) > r(s,B)
$$

这个式子表示：在同一个 prompt $s$ 下，人类更偏好的回答 $A$ 应该比回答 $B$ 拥有更高的隐含 reward。这里的 $A$ 和 $B$ 是两个候选 completion，$r(s,A)$ 和 $r(s,B)$ 分别表示它们在该 prompt 下的 reward。这里没有写成 $r_\psi$，是因为 DPO 不显式训练一个带参数的 Reward Model。

DPO 的关键是把 KL-regularized RLHF 目标经过推导，转化成一个可以直接训练 policy 的 supervised-style objective。它绕过了显式 Reward Model，但偏好背后仍然隐含着某种 reward ordering。

所以在文章语境里，可以把 DPO 放在一个中间位置：

```text
RLHF: explicit reward learning + policy optimization
DPO: implicit reward learning inside policy optimization
```

它不是传统意义上“先训练 Reward Model，再跑 RL”的流程，但仍然属于从人类偏好中学习行为偏好的路线。换句话说，DPO 弱化了 Reward Model 这个模块，却没有消除 reward-source 问题。

## 7. RLVR：thinking 模型常用的是可验证 reward，不是 IRL

如果文章只讲到这里，很容易给人一种印象：LLM RL 基本都可以看成 IRL。但 reasoning / thinking 模型让事情变得更清楚，也更有趣。

对数学、代码、形式化证明、工具调用这类任务，reward 往往可以直接验证：

```text
数学题：最终答案是否正确
代码题：单元测试是否通过
工具调用：API 是否成功完成任务
游戏环境：最终分数是多少
```

这类训练通常被称为 RL with Verifiable Rewards，简称 RLVR。它和 RLHF 的核心区别不在于是否使用 RL，而在于 reward 来源不同。

这里说 reward 是“known”，不是说这个 reward 一定完美，也不是说它覆盖了任务的全部质量标准；而是说它不需要从偏好数据中学习，可以由 checker、unit test、verifier 或环境规则直接计算。

RLHF 是：

```text
Human Preference
        ↓
Learned Reward Model
        ↓
RL
```

RLVR 是：

```text
Model Answer
        ↓
Verifier / Checker / Test
        ↓
Known reward
        ↓
RL
```

如果一道数学题的答案是 42，那么 reward 可以直接写：

$$
r(a)=
\begin{cases}
1, & \text{if } \mathrm{answer}(a)=42 \\
0, & \text{otherwise}
\end{cases}
$$

这个式子表示：对模型生成的回答 $a$，如果从中抽取出的最终答案 $\mathrm{answer}(a)$ 等于标准答案 $42$，reward 就是 $1$；否则 reward 是 $0$。这里的 reward 不需要从人类偏好中学习，而是由 checker 直接给出。

如果一段代码通过所有测试，reward 也可以直接给 1。这里没有从专家行为中反推 reward，也不需要 Reward Model 学习“什么叫正确”。Verifier 执行的是一个已知规则，而 Reward Model 学的是一个未知偏好。

这就是为什么说，主流 reasoning / thinking 训练里的 RLVR 通常不是 IRL。它更接近标准 RL：reward 已经定义好，算法负责搜索能获得高 reward 的策略。

当然，完整的大模型产品不只训练推理能力。一个 reasoning model 可能在数学和代码上使用 RLVR，在聊天、安全、拒答风格上仍然使用 RLHF 或偏好学习。因此更准确的理解是：

```text
Reasoning ability: often RLVR
Assistant alignment: often RLHF / preference learning
```

同一个模型可以同时经历这两类后训练，只是它们解决的问题不同。

## 8. PRM：过程奖励又把问题带回 reward learning

RLVR 通常奖励最终答案，但推理任务里还有一个自然问题：能不能奖励中间过程？

例如数学推理中，模型可能最终答案正确，但推理过程有跳步；也可能最终答案错误，但前几步是有价值的。于是出现了 Process Reward Model（PRM）：

```text
Question
        ↓
Reasoning steps
        ↓
Score each step
```

如果每一步是否正确可以由形式化 verifier 判断，那么它仍然更接近 verifiable reward。但很多时候，“这一步推理是否好”并没有唯一客观标准，需要人工标注、偏好比较或模型辅助评审。

这时 PRM 又带回了 IRL 风格的问题：我们不是直接知道每一步 reward，而是从人类对推理过程的判断中学习一个 reward model。它介于 RLHF 和 RLVR 之间：

```text
最终答案可验证 → 更像 RLVR
过程质量靠偏好标注 → 更像 IRL / reward learning
```

这也是为什么 reward source 这个维度比算法名字更清晰。只要 reward 需要从偏好、示范或人工判断中学习，就会带有 IRL 色彩；只要 reward 可以由环境规则直接给出，就更接近标准 RL。

## 9. 一张表看清几条路线

| 训练路线 | Reward 来源 | Reward 是否来自学习/偏好信号 | 是否接近 IRL |
| --- | --- | --- | --- |
| 传统 RL | 手工定义或环境给出 | 否 | 否 |
| IRL | 专家示范 | 是 | 是 |
| RLHF / RLAIF | 人类或 AI 偏好 | 是，通常显式训练 Reward Model | 是，IRL 风格 |
| DPO | 偏好数据 | 无显式 Reward Model，但有隐含 reward ordering | 部分接近 |
| RLVR | verifier、unit test、checker、环境分数 | 通常否，reward 可直接计算 | 通常否 |
| PRM | 过程标注、偏好或 verifier | 视来源而定 | 可能接近 |
| Safety Alignment | 人类偏好、红队反馈、规则系统 | 常常需要 | 常常接近 |

这张表的重点不是给每个方法贴标签，而是提醒我们：讨论 LLM RL 时，应该先问 reward 的来源和性质。

如果 reward 来自人类偏好，最大的问题是偏好数据是否稳定、Reward Model 是否泛化、是否会被 policy hack。如果 reward 来自 verifier，最大的问题则变成 verifier 覆盖了什么、是否过于稀疏、会不会诱导模型只优化最终答案而牺牲过程质量。

这两类问题都叫 RL，但工程难点完全不同。

## 10. 几个知名模型怎么放进这张图

很多读者熟悉的是模型名字，而不是背后的后训练流程。需要先说明一点：商业模型的完整训练细节通常不会公开，下面只放公开论文、系统卡或技术报告中能确认的高层信息，不把未披露细节当成事实。

| 模型或论文 | 公开资料里能确认的训练线索 | 放到本文框架里怎么理解 |
| --- | --- | --- |
| InstructGPT / GPT-3 alignment | 先用人工示范做 SFT，再用人类对多个回答的排序训练 Reward Model，最后用 PPO 做 RLHF。 | 典型 RLHF：reward 来自人类偏好，因此是 IRL 风格的 learned reward。 |
| ChatGPT 类 assistant | 具体每代细节并不完全公开，但公开说明和 InstructGPT 论文共同展示了“预训练模型 + 指令微调 + 人类反馈后训练”的基本路线。 | 更适合把它理解成产品化后的 assistant pipeline，而不是某一个固定算法。 |
| Llama 2-Chat | 论文公开了 SFT、helpfulness / safety reward models，以及使用 rejection sampling 和 PPO 的迭代式 RLHF。 | 仍是 preference alignment：reward 主要来自人类偏好模型，但优化方式不只一种。 |
| Claude / Constitutional AI | Constitutional AI 论文描述了 supervised self-critique / revision 阶段，以及用 AI preference model 作为 reward signal 的 RLAIF 阶段。 | RLAIF 和 RLHF 类似，区别是偏好反馈更多由 AI 根据原则生成；reward 仍然是 learned reward。 |
| DeepSeek-R1-Zero / DeepSeek-R1 | R1-Zero 公开描述为在 base model 上直接做大规模 RL；奖励主要是 rule-based accuracy reward 和 format reward。R1 加入 cold-start data 和多阶段训练。 | reasoning RL / RLVR 的典型例子：数学、代码等任务里的 reward 可以由规则、答案或测试直接验证。 |
| OpenAI o1 | 系统卡公开说明 o1 系列通过大规模 reinforcement learning 学习 chain-of-thought reasoning，但没有披露完整 reward 细节。 | 可以作为 reasoning RL 的代表，但不应武断说它等同于某一种公开 RLVR 配方。 |

这个表的作用不是给模型排队，而是帮助读者把熟悉的名字映射到 reward source：InstructGPT、Llama 2-Chat、Constitutional AI 更接近 learned preference reward；DeepSeek-R1-Zero 更接近 rule-based / verifiable reward；o1 公开确认了大规模 RL reasoning，但 reward 细节应保持谨慎。

## 11. 结论：LLM 后训练的分水岭是 reward source

从 IRL 一路看到 LLM RL，可以得到一个比较清晰的框架：

```text
Reward known:
    Standard RL / RLVR
    重点是优化 policy

Reward unknown:
    IRL / RLHF / preference alignment
    重点是学习 reward
```

这里的“known”指 reward 可以由规则、checker、verifier 或环境直接计算；它不等于 reward 一定完整、鲁棒或不可被利用。

RLHF 之所以和 IRL 有关系，不是因为它用了 PPO，而是因为它从人类偏好中学习 reward。DPO 之所以仍然可以放进这个讨论，也不是因为它显式建模 reward，而是因为偏好数据本身隐含了 reward ordering。

而 reasoning / thinking 模型里的 RLVR 则提醒我们：并不是所有 LLM RL 都是 IRL。当任务有明确 verifier 时，reward 可以直接给出，训练更像标准 RL。数学、代码、工具调用等任务之所以适合 RLVR，正是因为它们有相对客观的反馈信号。

因此，一个更稳妥的总结是：

> Alignment 更多依赖 learned reward，因为“好回答”很难直接写成函数；Reasoning 更多依赖 verifiable reward，因为“答案是否正确”常常可以被环境验证。

这也解释了为什么 LLM 后训练正在从早期“RLHF 约等于 LLM RL”的叙事，分化成两条并行路线：一条面向偏好、价值和安全，对 reward learning 要求更高；另一条面向数学、代码和工具使用，对 verifier 和可验证环境要求更高。

最终，LLM RL 的核心问题也许不是“PPO 还是 GRPO”，而是更朴素的一句：

> 我们到底是在优化一个已知 reward，还是在学习一个未知 reward？

这个问题回答清楚了，IRL、RLHF、DPO、RLVR 和 PRM 之间的关系，也就清楚了。

## 参考

- Berkeley CS 185/285 Deep Reinforcement Learning, Decision Making, and Control, Section 7: [Inverse Reinforcement Learning and LLM RL](https://rail.eecs.berkeley.edu/deeprlcourse/static/sections/section-7.pdf)
- OpenAI, 2022: [Aligning language models to follow instructions](https://openai.com/index/instruction-following/)
- Ouyang et al., 2022: [Training language models to follow instructions with human feedback](https://arxiv.org/abs/2203.02155)
- Touvron et al., 2023: [Llama 2: Open Foundation and Fine-Tuned Chat Models](https://arxiv.org/abs/2307.09288)
- Bai et al., 2022: [Constitutional AI: Harmlessness from AI Feedback](https://arxiv.org/abs/2212.08073)
- Rafailov et al., 2023: [Direct Preference Optimization: Your Language Model is Secretly a Reward Model](https://arxiv.org/abs/2305.18290)
- DeepSeek-AI, 2025: [DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning](https://arxiv.org/html/2501.12948)
- OpenAI, 2024: [OpenAI o1 System Card](https://openai.com/index/openai-o1-system-card/)
